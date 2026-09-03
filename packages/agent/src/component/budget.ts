import { intent, Self, type Transition, type Intent } from "@clavia/tardigrade-core/runtime"
import {
  actorCall,
  actorInvocationContextOf,
  calls,
  composeComponents,
  inheritComponentContract,
  component as defineComponent,
  type ActorRef,
  type ComponentRequirements
} from "@clavia/tardigrade-core/actor"
import { budgetDenied, budgetExhausted, budgetGranted, budgetRequested } from "../log/events"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { turnEpochOf, turnHead, turnView } from "@clavia/tardigrade-code/execution/turns"
import {
  initialTurnProjection,
  reduceTurnProjection,
  turnViewFrom,
  type TurnProjectionState
} from "@clavia/tardigrade-code/execution/turn-projection"
import { Chunk } from "effect"
import { AGENT_VIEW_ALGEBRA, type AgentComponent, type AgentTool, type AgentView } from "../runtime/composition"
import type { ToolSpec } from "../inference/request"
import { Router } from "@clavia/tardigrade-core/communication/router"
import { formatThreadAddress, isThreadAddress, type ThreadAddress } from "@clavia/tardigrade-core/communication/endpoint"
import type { Link } from "@clavia/tardigrade-core/communication/link"
import { threadCreatedOf } from "@clavia/tardigrade-core/thread"
import { requestBudgetMethod } from "../actor/budget"

// BudgetPolicy sets the tool-call limit for turns that declare no budget.
export interface BudgetPolicy {
  readonly limit: number
}

export interface CallerBudgetAuthority {
  readonly kind: "caller"
  readonly methods: BudgetAuthorityMethods
}

export type BudgetAuthorityMethods = {
  readonly requestBudget: typeof requestBudgetMethod
}

// BudgetAuthority identifies an actor that handles requestBudget or resolves it from the accepted call.
export type BudgetAuthority = ActorRef<BudgetAuthorityMethods> | CallerBudgetAuthority

// caller selects the actor that invoked the current message call as its budget authority.
export const caller = (): CallerBudgetAuthority => ({
  kind: "caller",
  methods: { requestBudget: requestBudgetMethod }
})

export interface BudgetOptions extends Partial<BudgetPolicy> {
  readonly authority?: BudgetAuthority
}

// DEFAULT_BUDGET_POLICY is the default policy applied by budget and spawned agents.
export const DEFAULT_BUDGET_POLICY: BudgetPolicy = { limit: 40 }

// budgetPolicyOf applies the exported default to omitted policy fields.
export const budgetPolicyOf = (policy: Partial<BudgetPolicy> = {}): BudgetPolicy => ({
  limit: (() => {
    const limit = policy.limit ?? DEFAULT_BUDGET_POLICY.limit
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error(`budget limit must be a positive integer, got ${JSON.stringify(limit)}`)
    }
    return limit
  })()
})

// budgetOf returns the turn's declared or default budget plus every recorded grant
// (budget.test.ts, "a grant raises the ceiling, so budgetOf grows and the machine reopens").
export const budgetOf = (view: ReadonlyArray<Event>, policy: Partial<BudgetPolicy> = {}): number => {
  const head = turnHead(view) as { budget?: unknown } | undefined
  const base =
    typeof head?.budget === "number" && head.budget > 0
      ? Math.floor(head.budget)
      : budgetPolicyOf(policy).limit
  const granted = view.reduce((n, e) => (e.type === "BudgetGranted" ? n + Number((e as { amount?: unknown }).amount ?? 0) : n), 0)
  return base + granted
}

// escalatableOf reports whether the turn head permits budget escalation.
export const escalatableOf = (view: ReadonlyArray<Event>): boolean =>
  (turnHead(view) as { escalatable?: unknown } | undefined)?.escalatable === true

// shadowOf reports whether the turn head marks a shadow run.
export const shadowOf = (view: ReadonlyArray<Event>): boolean =>
  (turnHead(view) as { shadow?: unknown } | undefined)?.shadow === true

// worldOf returns the shared world named by the turn head, if present (docs/worlds.md).
export const worldOf = (view: ReadonlyArray<Event>): string | undefined => {
  const w = (turnHead(view) as { world?: unknown } | undefined)?.world
  return typeof w === "string" && w !== "" ? w : undefined
}

// BudgetPhase names whether a turn may spend, request more budget, or must finish.
export type BudgetPhase = "spending" | "exhausted" | "denied"

// budgetPhase returns the phase established by the latest lifecycle marker
// (budget.test.ts, "budgetPhase reads the most recent marker").
export const budgetPhase = (trajectory: ReadonlyArray<Event>): BudgetPhase => {
  for (let i = trajectory.length - 1; i >= 0; i--) {
    const t = trajectory[i]!.type
    if (t === "BudgetExhausted") return "exhausted"
    if (t === "BudgetDenied") return "denied"
    if (t === "BudgetGranted") return "spending"
    if (t === "MessageReceived") return "spending"
  }
  return "spending"
}

// budgetSpent reports whether the budgeted subtree is withdrawn for this turn.
export const budgetSpent = (trajectory: ReadonlyArray<Event>): boolean => budgetPhase(trajectory) !== "spending"

// canRequestBudget reports whether an escalatable turn is at an open budget wall.
export const canRequestBudget = (trajectory: ReadonlyArray<Event>): boolean =>
  budgetPhase(trajectory) === "exhausted" && escalatableOf(trajectory)

const wallFor = (
  trajectory: ReadonlyArray<Event>,
  policy: BudgetPolicy,
  used: number
): Intent<never> | undefined => {
  if (trajectory.length === 0 || budgetPhase(trajectory) !== "spending") return undefined
  const budget = budgetOf(trajectory, policy)
  if (used <= budget) return undefined
  const head = turnHead(trajectory) as { id?: unknown } | undefined
  const turn = head?.id === undefined ? undefined : String(head.id)
  return intent({
    key: `bw:${turn ?? ""}/${budget}`,
    ...(turn === undefined ? {} : {
      invocation: { method: "message", id: turn, epoch: turnEpochOf(trajectory, turn) }
    }),
    input: { turn, budget, used },
    events: (input, at) => [
      budgetExhausted({
        budget: input.budget,
        used: input.used,
        ...(input.turn === undefined ? {} : { turn: input.turn }),
        at
      })
    ]
  })
}

const REQUEST_BUDGET_TOOL: ToolSpec = {
  name: "request_budget",
  description:
    "Ask for more tool-call budget when the work is not done and the budget is spent. State why the extra spend is worth it and how many more calls you need. The parent decides; a grant lets you keep working, a denial means finish with what you have.",
  inputSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Why more budget is worth it: what is still missing and what you will do with the calls." },
      amount: { type: "integer", minimum: 1, description: "How many more tool calls you need." }
    },
    required: ["reason", "amount"],
    additionalProperties: false
  }
}

const BUDGET_NUDGE =
  "Your tool budget for this turn is spent, so the budgeted tools are gone. Finish now: answer with your best result from what you have already gathered."

const ESCALATE_NUDGE =
  "If the work genuinely needs more and the extra spend is worth it, you may call request_budget with a reason and an amount instead of answering. Ask only when it changes the result; otherwise answer now."

const field = (event: Event, name: string): string => String((event as Record<string, unknown>)[name] ?? "")

const requestBudgetTool: AgentTool = {
  spec: REQUEST_BUDGET_TOOL,
  serve: (call, log, answer) => {
    const stamp = call.turn === undefined ? {} : { turn: call.turn }
    const requested = log.some(
      (event) => event.type === "BudgetRequested" && field(event, "callId") === call.callId
    )
    if (requested) {
      const decision = log.find(
        (event) =>
          (event.type === "BudgetGranted" || event.type === "BudgetDenied") &&
          field(event, "callId") === call.callId &&
          (call.turn === undefined || field(event, "turn") === "" || field(event, "turn") === call.turn)
      )
      if (decision === undefined) return []
      if (decision.type === "BudgetGranted") {
        return [answer({ granted: Number((decision as { amount?: unknown }).amount ?? 0) })]
      }
      const reason = field(decision, "reason")
      return [answer({
        denied: true,
        ...(reason === "" ? {} : { reason }),
        note: "No more budget. Answer now with your best result."
      })]
    }
    const args = call.arguments as { reason?: unknown; amount?: unknown } | undefined
    const amount = args?.amount
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
      return [answer({ error: `request_budget takes amount as a positive integer; got ${JSON.stringify(amount)}` })]
    }
    return [
      intent({
        key: `br:${call.callId}`,
        ...(call.turn === undefined ? {} : {
          invocation: { method: "message", id: call.turn, epoch: call.epoch ?? 0 }
        }),
        input: { callId: call.callId, reason: String(args?.reason ?? ""), amount },
        events: (input, at) => [budgetRequested({ ...input, ...stamp, at })]
      })
    ]
  }
}

const requestCallId = (child: ThreadAddress, turn: string, request: string): string =>
  `budget/${formatThreadAddress(child)}/${turn}/${request}`

const authorityFor = (
  log: ReadonlyArray<Event>,
  turn: string,
  authority: BudgetAuthority | undefined
): ActorRef<BudgetAuthorityMethods> | undefined => {
  if (authority === undefined) return undefined
  if ("address" in authority) return authority
  const head = log.find((event) =>
    event.type === "MessageReceived" && String((event as { readonly id?: unknown }).id) === turn
  ) as { readonly link?: Link<unknown, ThreadAddress> } | undefined
  return isThreadAddress(head?.link?.source)
    ? { address: head.link.source, methods: { requestBudget: requestBudgetMethod } }
    : undefined
}

const sourceFor = (log: ReadonlyArray<Event>, turn: string): ThreadAddress | undefined => {
  const head = log.find((event) =>
    event.type === "MessageReceived" && String((event as { readonly id?: unknown }).id) === turn
  ) as { readonly link?: Link<unknown, unknown> } | undefined
  if (isThreadAddress(head?.link?.target)) return head.link.target
  return threadCreatedOf(log)?.address
}

const budgetCommunication = (
  log: ReadonlyArray<Event>,
  authority: BudgetAuthority | undefined
): ReadonlyArray<Transition<never, Router | Self>> => {
  const requested = log.find((event) =>
    event.type === "BudgetRequested" &&
    !log.some((decision) =>
      (decision.type === "BudgetGranted" || decision.type === "BudgetDenied") &&
      String((decision as { readonly callId?: unknown }).callId) === String((event as { readonly callId?: unknown }).callId)
    )
  ) as { readonly callId?: unknown; readonly reason?: unknown; readonly amount?: unknown; readonly turn?: unknown } | undefined
  if (requested === undefined) return []
  const turn = String(requested.turn ?? "")
  const request = String(requested.callId ?? "")
  const target = authorityFor(log, turn, authority)
  const source = sourceFor(log, turn)
  if (target === undefined || source === undefined) return []
  const callId = requestCallId(source, turn, request)
  const invocation = { method: "message", id: turn, epoch: turnEpochOf(log, turn) }
  const call = actorCall(log, {
    id: callId,
    target,
    method: "requestBudget",
    context: actorInvocationContextOf(log, invocation) ?? { invocation },
    input: {
      request,
      turn,
      reason: String(requested.reason ?? ""),
      amount: Number(requested.amount ?? 0)
    }
  })
  if (call.transitions.length > 0) return call.transitions
  if (call.state.status === "pending") return []
  const output = call.state.status === "completed" ? call.state.output : undefined
  const grant = Number(output !== undefined && "granted" in output ? output.granted : 0)
  const reason = output !== undefined && "denied" in output ? output.reason : undefined
  return [intent({
    key: `bdec:${request}`,
    invocation,
    input: { request, turn, grant, reason, state: call.state },
    events: (current, at) => Number.isSafeInteger(current.grant) && current.grant > 0
      ? [budgetGranted({ amount: current.grant, callId: current.request, turn: current.turn, at })]
      : [budgetDenied({
          reason: typeof current.reason === "string"
            ? current.reason
            : current.state.status === "failed"
              ? current.state.error
              : "the budget authority denied the request",
          callId: current.request,
          turn: current.turn,
          at
        })]
  })]
}

const usedBy = (trajectory: ReadonlyArray<Event>, toolNames: ReadonlySet<string>): number =>
  trajectory.filter(
    (event) => event.type === "ToolCalled" && toolNames.has(String((event as { name?: unknown }).name))
  ).length

const guardedTool = <R>(
  tool: AgentTool<R>,
  toolNames: ReadonlySet<string>,
  policy: BudgetPolicy
): AgentTool<R> => ({
  spec: tool.spec,
  serve: (call, log, answer): ReadonlyArray<Transition<never, R>> => {
    const trajectory = turnView(log)
    if (budgetSpent(trajectory)) {
      return [answer({
        error: "Tool budget reached. Do not call this tool again. Answer now with your best result from what you have already gathered."
      })] as ReadonlyArray<Transition<never, R>>
    }
    const wall = wallFor(trajectory, policy, usedBy(trajectory, toolNames))
    if (wall !== undefined) return [wall]
    return tool.serve(call, log, answer)
  }
})

// budget applies tool-call admission to an agent subtree. It records the wall before dispatching the
// first call over the limit (budget.test.ts, "settling an over-budget execute records the wall and
// never dispatches the call").
export const budget = <
  const Cs extends ReadonlyArray<AgentComponent<never> | AgentComponent<unknown>>
>(
  components: Cs,
  options: BudgetOptions = {}
): AgentComponent<ComponentRequirements<Cs[number]> | Router | Self> => {
  type R = ComponentRequirements<Cs[number]>
  const resolved = budgetPolicyOf(options)
  const combined = composeComponents("budget.children", AGENT_VIEW_ALGEBRA, components) as AgentComponent<R>
  const childMachine = combined.machine
  const common = {
    name: "budget",
    ...(combined.keys === undefined ? {} : { keys: combined.keys })
  }
  const derived = (children: ReturnType<typeof childMachine.output>, trajectory: ReadonlyArray<Event>, log: ReadonlyArray<Event>) => {
    const spent = budgetSpent(trajectory)
    const turn = String((turnHead(trajectory) as { readonly id?: unknown } | undefined)?.id ?? "")
    const canRequest = canRequestBudget(trajectory) && authorityFor(log, turn, options.authority) !== undefined
    const toolNames = new Set(children.view.tools.map((tool) => tool.spec.name))
    return {
      view: {
        system: spent
          ? [...children.view.system, canRequest ? `${BUDGET_NUDGE}\n${ESCALATE_NUDGE}` : BUDGET_NUDGE]
          : children.view.system,
        tools: spent
          ? (canRequest ? [requestBudgetTool] : [])
          : children.view.tools.map((tool) => guardedTool(tool as AgentTool<R>, toolNames, resolved)),
        context: children.view.context,
        output: children.view.output
      },
      transitions: [...budgetCommunication(log, options.authority), ...children.transitions] as ReadonlyArray<Transition<never, R | Router | Self>>
    }
  }
  const communicationEvent = (event: Event): boolean =>
    event.type === "MessageReceived" ||
    event.type === "ThreadCreated" ||
    event.type === "BudgetRequested" ||
    event.type === "BudgetGranted" ||
    event.type === "BudgetDenied" ||
    event.type === "CallPlanned" ||
    event.type === "CallDispatched" ||
    event.type === "CallSkipped" ||
    event.type === "CallTimedOut" ||
    event.type === "ResponseReceived" ||
    event.type === "InvocationLinked"
  type BudgetState = {
    readonly children: unknown
    readonly turns: TurnProjectionState
    readonly communication: Chunk.Chunk<Event>
  }
  const component: AgentComponent<R | Router | Self> = defineComponent<BudgetState, AgentView, R | Router | Self>({
    ...common,
    initial: () => ({
      children: childMachine.initial(),
      turns: initialTurnProjection(),
      communication: Chunk.empty<Event>()
    }),
    step: (state, event) => ({
      children: childMachine.step(state.children, event),
      turns: reduceTurnProjection(state.turns, event),
      communication: communicationEvent(event) ? Chunk.append(state.communication, event) : state.communication
    }),
    cancelState: (state, cancellation) => childMachine.cancel?.(state.children, cancellation) ?? [],
    output: (state) => derived(
      childMachine.output(state.children),
      turnViewFrom(state.turns),
      Chunk.toReadonlyArray(state.communication)
    )
  })
  const inherited = inheritComponentContract<AgentView, R | Router | Self>(component, combined)
  return options.authority === undefined
    ? inherited
    : calls(options.authority, requestBudgetMethod, inherited)
}
