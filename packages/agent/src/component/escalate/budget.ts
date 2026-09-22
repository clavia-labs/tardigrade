import { calls, component as defineComponent, type ThreadTarget } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { Self, type Transition } from "@clavia/tardigrade-core/runtime"
import { bindTransitionContext } from "@clavia/tardigrade-core/transition/transition"
import { actorCall } from "@clavia/tardigrade-core/interaction/invoke"
import { actorInvocationContextOf } from "@clavia/tardigrade-core/interaction/invocation"
import { threadCreatedOf } from "@clavia/tardigrade-core/interaction/relations"
import { Router } from "@clavia/tardigrade-core/transport/router"
import { formatThreadAddress, isThreadAddress, type ThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import type { Link } from "@clavia/tardigrade-core/transport/link"
import { turnEpochOf, turnHead } from "@clavia/tardigrade-code/execution/turns"
import {
  initialTurnProjection,
  reduceTurnProjection,
  turnViewFrom,
  type TurnProjectionState
} from "@clavia/tardigrade-code/execution/turn-projection"
import { Chunk } from "effect"
import { requestBudgetMethod } from "../../actor/budget"
import { budgetRequested } from "../../log/events"
import { type AgentComponent, type ToolOffer, type ToolInteractions, type AgentView } from "../view"
import type { ToolSpec } from "../../model/request"
import { toolComponent } from "../tool/machine"
import type { BudgetAuthority, BudgetAuthorityMethods } from "./budget-authority"
import type { BudgetComponent, BudgetControl, BudgetState } from "../budget/index"

// DEFAULT_ESCALATION_TOOL describes an allowance request and can be replaced at the wrapping boundary (escalation.test.ts).
export const DEFAULT_ESCALATION_TOOL: ToolSpec = {
  name: "request_budget",
  description:
    "Ask for more budget when the work is not done and the budget is spent. State why the extra spend is worth it and how much more allowance you need. The parent decides; a grant lets you keep working, a denial means finish with what you have.",
  inputSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Why more budget is worth it: what is still missing and what you will do with the allowance."
      },
      amount: { type: "integer", minimum: 1, description: "How many additional budget units you need." }
    },
    required: ["reason", "amount"],
    additionalProperties: false
  }
}

// DEFAULT_EXHAUSTED_MESSAGE explains exhaustion in the model view (escalation.test.ts).
export const DEFAULT_EXHAUSTED_MESSAGE =
  "Your budget for this turn is spent. Finish now: answer with your best result from what you have already gathered."

// DEFAULT_ESCALATION_MESSAGE explains the available request tool (escalation.test.ts).
export const DEFAULT_ESCALATION_MESSAGE =
  "If additional budget would change the result, you may call request_budget with a reason and an amount instead of answering. Ask only when it changes the result; otherwise answer now."

const field = (event: Event, name: string): string => String((event as Record<string, unknown>)[name] ?? "")

const requestBudgetTool = (spec: ToolSpec): ToolOffer => ({
  spec,
  serve: (call, log, answer) => {
    const requestId = `tool/${call.position}`
    const stamp = call.turn === undefined ? {} : { turn: call.turn }
    const requested = log.some(
      (event) =>
        event.type === "BudgetRequested" &&
        field(event, "callId") === requestId &&
        (event.turn ?? "") === (call.turn ?? "")
    )
    if (requested) {
      const decision = log.find(
        (event) =>
          (event.type === "BudgetGranted" || event.type === "BudgetDenied") &&
          field(event, "callId") === requestId &&
          (call.turn === undefined || field(event, "turn") === "" || field(event, "turn") === call.turn)
      )
      if (decision === undefined) return []
      if (decision.type === "BudgetGranted") {
        return [answer({ granted: Number((decision as { amount?: unknown }).amount ?? 0) })]
      }
      const reason = field(decision, "reason")
      return [
        answer({
          denied: true,
          ...(reason === "" ? {} : { reason }),
          note: "No more budget. Answer now with your best result."
        })
      ]
    }
    const args = call.arguments as { reason?: unknown; amount?: unknown } | undefined
    const amount = args?.amount
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
      return [answer({ error: `${spec.name} takes amount as a positive integer; got ${JSON.stringify(amount)}` })]
    }
    return [
      call.context.intent(
        "budget.request",
        (at) =>
          budgetRequested({
            callId: requestId,
            reason: String(args?.reason ?? ""),
            amount,
            ...stamp,
            at
          }),
        call.turn === undefined ? {} : { invocation: { method: "message", id: call.turn, epoch: call.epoch ?? 0 } }
      )
    ]
  }
})

const requestCallId = (child: ThreadAddress, turn: string, request: string): string =>
  `budget/${formatThreadAddress(child)}/${turn}/${request}`

const authorityFor = (
  log: ReadonlyArray<Event>,
  turn: string,
  authority: BudgetAuthority
): ThreadTarget<BudgetAuthorityMethods> | undefined => {
  if ("coordinate" in authority || "address" in authority) return authority
  const head = log.find(
    (event) => event.type === "MessageReceived" && String((event as { readonly id?: unknown }).id) === turn
  ) as { readonly link?: Link<unknown, ThreadAddress> } | undefined
  return isThreadAddress(head?.link?.source)
    ? { coordinate: head.link.source, methods: {
      requestBudget: requestBudgetMethod
    } }
    : undefined
}

const sourceFor = (log: ReadonlyArray<Event>, turn: string): ThreadAddress | undefined => {
  const head = log.find(
    (event) => event.type === "MessageReceived" && String((event as { readonly id?: unknown }).id) === turn
  ) as { readonly link?: Link<unknown, unknown> } | undefined
  if (isThreadAddress(head?.link?.target)) return head.link.target
  return threadCreatedOf(log)?.address
}

const budgetCommunication = (
  log: ReadonlyArray<Event>,
  authority: BudgetAuthority,
  control: BudgetControl
): ReadonlyArray<Transition<never, Router | Self>> => {
  const requested = log.find(
    (event) =>
      event.type === "BudgetRequested" &&
      !log.some(
        (decision) =>
          (decision.type === "BudgetGranted" || decision.type === "BudgetDenied") &&
          String((decision as { readonly callId?: unknown }).callId) ===
            String((event as { readonly callId?: unknown }).callId) &&
          decision.turn === event.turn
      )
  )
  if (requested === undefined) return []
  const context = bindTransitionContext(requested, "budget.escalation")
  const turn = String(requested.turn ?? "")
  const request = String(requested.callId ?? "")
  const target = authorityFor(log, turn, authority)
  const source = sourceFor(log, turn)
  if (target === undefined || source === undefined) return []
  const callId = requestCallId(source, turn, request)
  const invocation = { method: "message", id: turn, epoch: turnEpochOf(log, turn) }
  const call = actorCall(
    log,
    {
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
    },
    { context, tag: "authority" }
  )
  if (call.transitions.length > 0) return call.transitions
  if (call.state.status === "pending") return []
  const output = call.state.status === "completed" ? call.state.output : undefined
  const grant = Number(output !== undefined && "granted" in output ? output.granted : 0)
  const reason = output !== undefined && "denied" in output ? output.reason : undefined
  return [
    context.intent(
      "decide",
      (at) =>
        Number.isSafeInteger(grant) && grant > 0
          ? control.grant(grant, { callId: request, turn }, at)
          : control.deny(
              typeof reason === "string"
                ? reason
                : call.state.status === "failed"
                  ? call.state.error
                  : "the budget authority denied the request",
              { callId: request, turn },
              at
            ),
      { invocation }
    )
  ]
}

export interface EscalationOptions {
  readonly authority: BudgetAuthority
  readonly tool?: ToolSpec
  readonly exhaustedMessage?: string
  readonly requestMessage?: string
}

// escalation offers budget requests outside the governed subtree and commits decisions through its protocol (escalation.test.ts).
export const escalation = <R, Result>(
  child: BudgetComponent<R, Result>,
  options: EscalationOptions
): AgentComponent<R | Router | Self, AgentView & BudgetState, Result> => {
  const name = `${child.name}.escalation`
  const budget = child.budget
  const requestTool = requestBudgetTool(options.tool ?? DEFAULT_ESCALATION_TOOL)
  type State = { readonly turns: TurnProjectionState; readonly log: Chunk.Chunk<Event> }
  const wrapped = defineComponent<State, AgentView & BudgetState, R | Router | Self, Result, typeof child, readonly [], ToolInteractions<R | Router | Self>>({
    children: child,
    name,
    initial: () => ({ turns: initialTurnProjection(), log: Chunk.empty<Event>() }),
    step: (state, event) => ({
      turns: reduceTurnProjection(state.turns, event),
      log: Chunk.append(state.log, event)
    }),


    output: (state, child) => {
      const output = child.output()
      const observation = child.output().view
      const log = Chunk.toReadonlyArray(state.log)
      const head = turnHead(turnViewFrom(state.turns))
      const available = observation.phase === "exhausted" &&
        head?.escalatable === true &&
        authorityFor(log, String(head?.id ?? ""), options.authority) !== undefined
      return {
        view: {
          ...output.view,
          tools: observation.phase === "spending"
            ? output.view.tools
            : available
              ? [{ spec: requestTool.spec }]
              : [],
          system: observation.phase === "spending"
            ? output.view.system
            : [
              ...output.view.system,
              options.exhaustedMessage ?? DEFAULT_EXHAUSTED_MESSAGE,
              ...(available ? [options.requestMessage ?? DEFAULT_ESCALATION_MESSAGE] : [])
            ]
        },
        transitions: [...output.transitions, ...budgetCommunication(log, options.authority, budget)],
        interactions: {
          tools: () => available ? [requestTool] : [],
          cancel: (cancellation) => child.output().interactions?.cancel?.(cancellation) ?? []
        }
      }
    }
  })
  return calls(
    options.authority,
    requestBudgetMethod,
    toolComponent(wrapped, { view: (view) => view })
  )
}
