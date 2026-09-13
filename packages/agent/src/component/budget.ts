import { startingBudget, needsInitialBudget } from "../log/budget"
import { bindTransitionContext, type TransitionContext } from "@clavia/tardigrade-core/transition/transition"
import { Self, type Transition, type Intent } from "@clavia/tardigrade-core/runtime"
import { actorCall } from "@clavia/tardigrade-core/interaction/invoke"
import { actorInvocationContextOf } from "@clavia/tardigrade-core/interaction/invocation"
import { calls, composeComponents, inheritComponentContract, component as defineComponent, type ThreadTarget, type ComponentRequirements } from "@clavia/tardigrade-core/actor"
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
import { usageIn } from "../inference/usage"
import { AGENT_VIEW_ALGEBRA, type AgentComponent, type AgentTool, type AgentView } from "../runtime/composition"
import type { ToolSpec } from "../inference/request"
import { Router } from "@clavia/tardigrade-core/transport/router"
import { formatThreadAddress, isThreadAddress, type ThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import type { Link } from "@clavia/tardigrade-core/transport/link"
import { threadCreatedOf } from "@clavia/tardigrade-core/interaction/relations"
import { requestBudgetMethod } from "../actor/budget"
import type { Projection } from "@clavia/tardigrade-core/projection"

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
export type BudgetAuthority = ThreadTarget<BudgetAuthorityMethods> | CallerBudgetAuthority

// caller selects the actor that invoked the current message call as its budget authority.
export const caller = (): CallerBudgetAuthority => ({
  kind: "caller",
  methods: { requestBudget: requestBudgetMethod }
})

export interface BudgetOptions extends Partial<BudgetPolicy> {
  readonly authority?: BudgetAuthority
}

// SpendBudgetOptions sets the observed dollar threshold for model-attempt admission.
export interface SpendBudgetOptions {
  readonly usd: number
  readonly onUnknown?: BudgetUnknownPolicy
}

export type BudgetUnknownPolicy = "block" | "admit"

// DEFAULT_BUDGET_ON_UNKNOWN is the admission policy used when a constraint projection has no value.
export const DEFAULT_BUDGET_ON_UNKNOWN: BudgetUnknownPolicy = "block"

// BudgetConstraint configures admission against a numeric log projection.
export interface BudgetConstraint {
  readonly limit: number
  readonly onUnknown?: BudgetUnknownPolicy
  readonly name?: string
}

interface ResolvedConstraint {
  readonly limit: number
  readonly onUnknown: BudgetUnknownPolicy
  readonly name: string
}

const constraintOf = (constraint: BudgetConstraint, fallbackName: string): ResolvedConstraint => {
  if (!Number.isFinite(constraint.limit) || constraint.limit <= 0) {
    throw new Error(`budget limit must be positive, got ${JSON.stringify(constraint.limit)}`)
  }
  const onUnknown = constraint.onUnknown ?? DEFAULT_BUDGET_ON_UNKNOWN
  if (onUnknown !== "block" && onUnknown !== "admit") {
    throw new Error(`budget onUnknown must be "block" or "admit", got ${JSON.stringify(onUnknown)}`)
  }
  return { limit: constraint.limit, onUnknown, name: constraint.name ?? fallbackName }
}

type BudgetDecision = "admitted" | "exhausted" | "unknown" | "unknown-admitted"

const budgetDecision = (
  observed: number | undefined,
  constraint: ResolvedConstraint,
  admission: "next" | "current" = "next"
): BudgetDecision => {
  if (observed === undefined) return constraint.onUnknown === "block" ? "unknown" : "unknown-admitted"
  if (!Number.isFinite(observed) || observed < 0) {
    throw new Error(`budget projection ${JSON.stringify(constraint.name)} must return a finite nonnegative number or undefined, got ${JSON.stringify(observed)}`)
  }
  return admission === "next"
    ? (observed >= constraint.limit ? "exhausted" : "admitted")
    : (observed > constraint.limit ? "exhausted" : "admitted")
}

// spendUsd projects the observed dollar cost of settled model attempts in the current turn.
export const spendUsd: Projection<TurnProjectionState, number | undefined> & { readonly budgetName: "spendUsd" } = {
  budgetName: "spendUsd",
  initial: initialTurnProjection,
  step: reduceTurnProjection,
  output: (state) => {
    const trajectory = turnViewFrom(state)
    const head = trajectory[0] as { readonly id?: unknown } | undefined
    if (head === undefined || !trajectory.some((event) => event.type === "ModelReturned")) return 0
    return usageIn(trajectory, String(head.id ?? "")).costUsd
  }
}

// toolCalls projects the number of tool-call actions supplied to it.
export const toolCalls: Projection<number, number> & { readonly budgetName: "toolCalls" } = {
  budgetName: "toolCalls",
  initial: () => 0,
  step: (count, event) => event.type === "ToolCalled" ? count + 1 : count,
  output: (count) => count
}

const constraintPolicy = (constraint: ResolvedConstraint, observed: number | undefined, reason: BudgetDecision) => ({
  constraint: constraint.name,
  limit: constraint.limit,
  observed: observed ?? null,
  onUnknown: constraint.onUnknown,
  reason: reason === "unknown-admitted" ? "unknown" : reason,
  admitted: reason === "admitted" || reason === "unknown-admitted"
})

const appliedConstraintOf = (trajectory: ReadonlyArray<Event>, fallback: ResolvedConstraint): ResolvedConstraint => {
  const initial = trajectory.find((event) => event.type === "BudgetGranted" && event.initial === true)
  const policy = initial?.policy
  const recordedLimit = typeof initial?.amount === "number" && Number.isFinite(initial.amount) && initial.amount > 0
    ? initial.amount
    : fallback.limit
  if (policy === null || typeof policy !== "object") return { ...fallback, limit: recordedLimit }
  const value = policy as Record<string, unknown>
  if (typeof value.constraint !== "string" || typeof value.limit !== "number" ||
      (value.onUnknown !== "block" && value.onUnknown !== "admit")) return fallback
  return constraintOf({ name: value.constraint, limit: value.limit, onUnknown: value.onUnknown }, fallback.name)
}

const projectionBudget = <State>(
  projection: Projection<State, number | undefined>,
  options: BudgetConstraint,
  compatibility?: "spendUsd"
): AgentComponent => {
  const projectedName = (projection as Projection<State, number | undefined> & { readonly budgetName?: unknown }).budgetName
  const constraint = constraintOf(options, compatibility ?? (typeof projectedName === "string" ? projectedName : "budget"))
  interface ConstraintState {
    readonly measure: State
    readonly turns: TurnProjectionState
  }
  return defineComponent<ConstraintState, AgentView>({
    name: compatibility === "spendUsd" ? "spend-budget" : `budget-${constraint.name}`,
    initial: () => ({ measure: projection.initial(), turns: initialTurnProjection() }),
    step: (state, event) => ({
      measure: projection.step(state.measure, event),
      turns: reduceTurnProjection(state.turns, event)
    }),
    output: (state) => {
      const observed = projection.output(state.measure)
      const decision = budgetDecision(observed, constraint)
      const genericPolicy = constraintPolicy(constraint, observed, decision)
      const policy = compatibility === "spendUsd"
        ? { ...genericPolicy, usd: constraint.limit, spentUsd: observed ?? null }
        : genericPolicy
      const attempts = turnViewFrom(state.turns).filter((event) => event.type === "ModelReturned").length
      const blocked = decision === "admitted" || decision === "unknown-admitted" ? undefined : {
        cause: "inference_budget_exhausted" as const,
        error: decision === "unknown"
          ? `the ${constraint.name} budget cannot admit another model attempt because recorded usage is unknown`
          : `the ${constraint.name} budget of ${constraint.limit} is exhausted after ${observed}`,
        attempts,
        policy
      }
      return {
        view: {
          system: [], tools: [], context: [], output: [],
          admission: [{ component: compatibility === "spendUsd" ? "spend-budget" : `budget-${constraint.name}`, policy, ...(blocked === undefined ? {} : { blocked }) }]
        },
        transitions: []
      }
    }
  })
}

const spendBudget = (options: SpendBudgetOptions): AgentComponent => {
  if (!Number.isFinite(options.usd) || options.usd <= 0) {
    throw new Error(`spend budget usd must be positive, got ${JSON.stringify(options.usd)}`)
  }
  return projectionBudget(spendUsd, {
    limit: options.usd,
    ...(options.onUnknown === undefined ? {} : { onUnknown: options.onUnknown })
  }, "spendUsd")
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

// budgetOf sums recorded grants, including the initial allowance, with a fallback for historical turns (budget.test.ts).
export const budgetOf = (view: ReadonlyArray<Event>, policy: Partial<BudgetPolicy> = {}): number => {
  const base = startingBudget(view, budgetPolicyOf(policy).limit)
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
  used: number | null,
  context: TransitionContext,
  applied?: unknown,
  appliedBudget?: number
): Intent<never> | undefined => {
  if (trajectory.length === 0 || budgetPhase(trajectory) !== "spending") return undefined
  const budget = appliedBudget ?? budgetOf(trajectory, policy)
  if (used !== null && used <= budget) return undefined
  const head = turnHead(trajectory) as { id?: unknown } | undefined
  const turn = head?.id === undefined ? undefined : String(head.id)
  return context.intent("budget.wall", (at) => budgetExhausted({
    budget, used, ...(applied === undefined ? {} : { policy: applied }), ...(turn === undefined ? {} : { turn }), at
  }), (turn === undefined ? {} : { invocation: { method: "message", id: turn, epoch: turnEpochOf(trajectory, turn) } }))
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
      (event) => event.type === "BudgetRequested" && field(event, "callId") === call.callId && (event.turn ?? "") === (call.turn ?? "")
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
      call.context.intent("budget.request", (at) => budgetRequested({
        callId: call.callId, reason: String(args?.reason ?? ""), amount, ...stamp, at
      }), (call.turn === undefined ? {} : { invocation: { method: "message", id: call.turn, epoch: call.epoch ?? 0 } }))
    ]
  }
}

const requestCallId = (child: ThreadAddress, turn: string, request: string): string =>
  `budget/${formatThreadAddress(child)}/${turn}/${request}`

const authorityFor = (
  log: ReadonlyArray<Event>,
  turn: string,
  authority: BudgetAuthority | undefined
): ThreadTarget<BudgetAuthorityMethods> | undefined => {
  if (authority === undefined) return undefined
  if ("coordinate" in authority || "address" in authority) return authority
  const head = log.find((event) =>
    event.type === "MessageReceived" && String((event as { readonly id?: unknown }).id) === turn
  ) as { readonly link?: Link<unknown, ThreadAddress> } | undefined
  return isThreadAddress(head?.link?.source)
    ? { coordinate: head.link.source, methods: { requestBudget: requestBudgetMethod } }
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
      String((decision as { readonly callId?: unknown }).callId) === String((event as { readonly callId?: unknown }).callId) && decision.turn === event.turn
    )
  ) as Event | undefined
  if (requested === undefined) return []
  const context = bindTransitionContext(requested, "budget")
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
  }, { context, tag: "authority" })
  if (call.transitions.length > 0) return call.transitions
  if (call.state.status === "pending") return []
  const output = call.state.status === "completed" ? call.state.output : undefined
  const grant = Number(output !== undefined && "granted" in output ? output.granted : 0)
  const reason = output !== undefined && "denied" in output ? output.reason : undefined
  return [context.intent("decide", (at) => Number.isSafeInteger(grant) && grant > 0
    ? budgetGranted({ amount: grant, callId: request, turn, at })
    : budgetDenied({
        reason: typeof reason === "string" ? reason : call.state.status === "failed"
          ? call.state.error : "the budget authority denied the request",
        callId: request, turn, at
      }), { invocation })]
}

// admissionOf fixes each call's budget decision from preceding grants and calls (runtime/batches.test.ts).
const admissionOf = <State>(
  trajectory: ReadonlyArray<Event>,
  toolNames: ReadonlySet<string>,
  policy: BudgetPolicy,
  projection: Projection<State, number | undefined>,
  constraint: ResolvedConstraint,
  callId: string
) => {
  let state = projection.initial()
  let granted = startingBudget(trajectory, policy.limit) - constraint.limit
  for (const event of trajectory) {
    if (event.type === "BudgetGranted") granted += Number(event.amount ?? 0)
    if (event.type !== "ToolCalled") {
      state = projection.step(state, event)
      continue
    }
    // admissionOf supplies scoped admitted ToolCalled events to action projections; unscoped and refused calls cannot consume later grants.
    if (!toolNames.has(String(event.name))) continue
    const candidate = projection.step(state, event)
    const observed = projection.output(candidate)
    const effective = { ...constraint, limit: constraint.limit + granted }
    const decision = budgetDecision(observed, effective, "current")
    const admitted = decision === "admitted" || decision === "unknown-admitted"
    if (admitted) {
      state = candidate
    }
    if (event.callId === callId) return { admitted, observed, decision, effective }
  }
  const effective = { ...constraint, limit: constraint.limit + granted }
  return { admitted: false, observed: undefined, decision: "unknown" as const, effective }
}

const guardedTool = <R, State>(
  tool: AgentTool<R>,
  toolNames: ReadonlySet<string>,
  policy: BudgetPolicy,
  projection: Projection<State, number | undefined>,
  constraint: ResolvedConstraint
): AgentTool<R> => ({
  ...tool,
  serve: (call, log, answer): ReadonlyArray<Transition<never, R>> => {
    const trajectory = turnView(log)
    const applied = appliedConstraintOf(trajectory, constraint)
    const admission = admissionOf(trajectory, toolNames, policy, projection, applied, call.callId)
    if (admission.admitted) return tool.serve(call, log, answer)
    const callIndex = trajectory.findIndex((event) => event.type === "ToolCalled" && event.callId === call.callId)
    const laterInitial = trajectory.slice(callIndex + 1).reduce(
      (amount, event) => event.type === "BudgetGranted" && event.initial === true ? amount + Number(event.amount ?? 0) : amount,
      0
    )
    const wallBudget = budgetOf(trajectory, policy) - laterInitial
    const wall = wallFor(
      trajectory,
      policy,
      admission.observed ?? null,
      call.context,
      constraintPolicy(admission.effective, admission.observed, admission.decision),
      wallBudget
    )
    return [
      ...(wall === undefined ? [] : [wall]),
      answer({ error: "Tool budget reached. Do not call this tool again. Answer now with your best result from what you have already gathered." })
    ] as ReadonlyArray<Transition<never, R>>
  }
})

// budget applies either observed-spend admission to model attempts or tool-call admission to an agent subtree. The spend form checks the recorded total before the next attempt, while the tool form records its wall before dispatching the first call over the limit (inference/spend-budget.test.ts; budget.test.ts, "settling an over-budget execute records the wall and never dispatches the call").
export function budget(options: SpendBudgetOptions): AgentComponent
export function budget<State>(
  projection: Projection<State, number | undefined>,
  constraint: BudgetConstraint
): AgentComponent
export function budget<
  State,
  const Cs extends ReadonlyArray<AgentComponent<never> | AgentComponent<unknown>>
>(
  components: Cs,
  projection: Projection<State, number | undefined>,
  options: BudgetOptions & BudgetConstraint
): AgentComponent<ComponentRequirements<Cs[number]> | Router | Self>
export function budget<
  const Cs extends ReadonlyArray<AgentComponent<never> | AgentComponent<unknown>>
>(
  components: Cs,
  options?: BudgetOptions
): AgentComponent<ComponentRequirements<Cs[number]> | Router | Self>
export function budget<
  State,
  const Cs extends ReadonlyArray<AgentComponent<never> | AgentComponent<unknown>>
>(
  components: SpendBudgetOptions | Projection<State, number | undefined> | Cs,
  options: BudgetOptions | BudgetConstraint | Projection<State, number | undefined> = {},
  constraintOptions?: BudgetOptions & BudgetConstraint
): AgentComponent<ComponentRequirements<Cs[number]> | Router | Self> {
  if (!Array.isArray(components)) {
    if ("usd" in components) return spendBudget(components as SpendBudgetOptions)
    return projectionBudget(components as Projection<State, number | undefined>, options as BudgetConstraint)
  }
  type R = ComponentRequirements<Cs[number]>
  const customProjection = typeof options === "object" && "initial" in options
    ? options as Projection<State, number | undefined>
    : toolCalls
  const toolProjection = customProjection as Projection<State, number | undefined>
  const toolOptions = (customProjection === options ? constraintOptions : options) as BudgetOptions
  const resolved = budgetPolicyOf(toolOptions)
  const constraint = constraintOf(
    customProjection === options
      ? constraintOptions ?? { limit: resolved.limit }
      : { limit: resolved.limit, name: "toolCalls" },
    "toolCalls"
  )
  const initialObserved = toolProjection.output(toolProjection.initial())
  budgetDecision(initialObserved, constraint, "current")
  const combined = composeComponents("budget.children", AGENT_VIEW_ALGEBRA, components as Cs) as AgentComponent<R>
  const childMachine = combined.machine
  const common = {
    name: "budget",
    children: [combined]
  }
  const derived = (children: ReturnType<typeof childMachine.output>, trajectory: ReadonlyArray<Event>, log: ReadonlyArray<Event>) => {
    const head = turnHead(trajectory)
    const initial = head !== undefined && needsInitialBudget(trajectory)
      ? [bindTransitionContext(head, "budget").intent("budget.initial", (at) => budgetGranted({
          amount: startingBudget(trajectory, resolved.limit),
          initial: true,
          policy: constraintPolicy(
            { ...constraint, limit: startingBudget(trajectory, resolved.limit) },
            initialObserved,
            budgetDecision(initialObserved, { ...constraint, limit: startingBudget(trajectory, resolved.limit) }, "current")
          ),
          turn: String(head.id),
          at
        }))]
      : []
    const spent = budgetSpent(trajectory)
    const turn = String(head?.id ?? "")
    const canRequest = canRequestBudget(trajectory) && authorityFor(log, turn, toolOptions.authority) !== undefined
    if (children.view.tools.some((tool) => tool !== requestBudgetTool && tool.spec.name === REQUEST_BUDGET_TOOL.name)) {
      throw new Error(`budget child tool name ${JSON.stringify(REQUEST_BUDGET_TOOL.name)} is reserved for escalation`)
    }
    const toolNames = new Set(children.view.tools.filter((tool) => tool !== requestBudgetTool).map((tool) => tool.spec.name))
    return {
      view: {
        system: spent
          ? [...children.view.system, canRequest ? `${BUDGET_NUDGE}\n${ESCALATE_NUDGE}` : BUDGET_NUDGE]
          : children.view.system,
        tools: spent
          ? (canRequest ? [requestBudgetTool] : [])
          : children.view.tools.map((tool) => tool === requestBudgetTool
            ? tool
            : guardedTool(tool as AgentTool<R>, toolNames, resolved, toolProjection, constraint)),
        context: children.view.context,
        output: children.view.output,
        ...(children.view.admission === undefined ? {} : { admission: children.view.admission })
      },
      transitions: [...initial, ...budgetCommunication(log, toolOptions.authority), ...children.transitions] as ReadonlyArray<Transition<never, R | Router | Self>>
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
  type ChildState = ReturnType<typeof childMachine.initial>
  type BudgetState = {
    readonly children: ChildState
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
  return toolOptions.authority === undefined
    ? inherited
    : calls(toolOptions.authority, requestBudgetMethod, inherited)
}
