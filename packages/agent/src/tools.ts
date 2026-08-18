import { Clock, Effect } from "effect"
import { transition, type Reactor, type Transition } from "@flamecast/core/actor"
import { budgetRequested, toolReturned } from "./events"
import type { Event } from "@flamecast/core/event"
import { turnView } from "@flamecast/code/turns"
import { budgetSpent } from "./budget"
import { answerErrors, outputSchemaOf, repairText } from "./contract"
import { codeSurface, type PendingCall, type ToolSurface } from "./surface"

// The tools reactor: the agent's side of the tool table. The policy here is the same whatever
// the tools are: the answer contract, the escalation ask, the budget wall, and the unknown-tool
// error. The work tools themselves come from a `ToolSurface`, so an agent measured against a
// fixed tool table swaps the surface and keeps every one of these behaviors (surface.ts).
//
// Owed work, derived from the event set: the head pending call (a ToolCalled with no
// ToolReturned, earliest by its own `at`) owes a routing until its dispatch or ask exists, an
// answer once its work settled, and an escalation answer once the parent decided.

const str = (v: unknown): string => String(v ?? "")

// pendingCall returns the head pending call: the earliest ToolCalled with no ToolReturned,
// ordered by its own `at` with the callId as the tiebreak.
const pendingCall = (log: ReadonlyArray<Event>): PendingCall | undefined => {
  const answered = new Set(
    log.filter((e) => e.type === "ToolReturned").map((e) => str((e as { callId?: unknown }).callId))
  )
  const head = log
    .filter((e) => e.type === "ToolCalled" && !answered.has(str((e as { callId?: unknown }).callId)))
    .sort((a, b) => {
      const d = Number((a as { at?: unknown }).at ?? 0) - Number((b as { at?: unknown }).at ?? 0)
      const ai = str((a as { callId?: unknown }).callId)
      const bi = str((b as { callId?: unknown }).callId)
      return d !== 0 ? d : ai < bi ? -1 : 1
    })[0] as { callId?: unknown; name?: unknown; arguments?: unknown; turn?: unknown } | undefined
  if (head === undefined) return undefined
  return {
    callId: str(head.callId),
    name: str(head.name),
    arguments: head.arguments,
    ...(head.turn === undefined ? {} : { turn: str(head.turn) })
  }
}

const has = (log: ReadonlyArray<Event>, type: string, key: string, value: string): boolean =>
  log.some((e) => e.type === type && str((e as Record<string, unknown>)[key]) === value)

// decisionFor returns the parent's decision on an escalation ask, scoped to the call's turn.
const decisionFor = (
  log: ReadonlyArray<Event>,
  turn: string | undefined
): { granted: number } | { denied: string } | undefined => {
  for (const e of log) {
    const t = (e as { turn?: unknown }).turn
    if (turn !== undefined && t !== undefined && str(t) !== turn) continue
    if (e.type === "BudgetGranted") return { granted: Number((e as { amount?: unknown }).amount ?? 0) }
    if (e.type === "BudgetDenied") return { denied: str((e as { reason?: unknown }).reason) }
  }
  return undefined
}

// toolsReactorFor derives one transition per pending call, branch by branch. The records each
// branch appends carry the keys: an answer tr:<callId>, an escalation ask br:<callId>, and
// whatever key the surface's own dispatch mints. An escalating call with no parental decision
// derives nothing (the turn is durably paused); the decision's arrival re-derives the answer.
// Every branch here is surface-independent policy; the surface decides only how a work call
// becomes events.
export const toolsReactorFor = <R = never>(surface: ToolSurface<R>): Reactor<R> => (log) => {
  const call = pendingCall(log)
  if (call === undefined) return []
  const stamp = call.turn === undefined ? {} : { turn: call.turn }
  const answering = (result: unknown): Transition<never, never> =>
    transition({
      key: `tr:${call.callId}`,
      input: { callId: call.callId, result },
      act: (input) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          return [toolReturned({ callId: input.callId, result: input.result, ...stamp, at })]
        })
    })

  // Escalation in flight: the answer exists only once the parent decided.
  if (has(log, "BudgetRequested", "callId", call.callId)) {
    const decision = decisionFor(log, call.turn)
    if (decision === undefined) return []
    if ("granted" in decision) return [answering({ granted: decision.granted })]
    const reason = decision.denied
    return [
      answering({ denied: true, ...(reason === "" ? {} : { reason }), note: "No more budget. Answer now with your best result." })
    ]
  }

  // The escalation ask: record the request and rest. No ToolReturned follows, so the turn is
  // durably paused; the parental decision derives the answer above.
  if (call.name === "request_budget") {
    const args = call.arguments as { reason?: unknown; amount?: unknown } | undefined
    const amount = typeof args?.amount === "number" && args.amount > 0 ? Math.floor(args.amount) : 0
    return [
      transition({
        key: `br:${call.callId}`,
        input: { callId: call.callId, reason: String(args?.reason ?? ""), amount },
        act: (input) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis
            return [budgetRequested({ callId: input.callId, reason: input.reason, amount: input.amount, ...stamp, at })]
          })
      })
    ]
  }
  // The answer tool only reaches here when its arguments missed the turn's schema: returning
  // the reasons puts the model back in thinking with its own errors to read.
  if (call.name === "answer") {
    const errors = answerErrors(outputSchemaOf(turnView(log)), call.arguments)
    return [answering({ error: repairText(errors.length > 0 ? errors : ["the answer tool was called with no arguments"]) })]
  }
  // The budget gate: the wall on the turn refuses the work and keeps what the model has. It
  // precedes the surface so a spent turn cannot dispatch, whatever the surface would have done.
  if (budgetSpent(log)) {
    return [
      answering({
        error: "Tool budget reached. Do not call this tool again. Answer now with your best result from what you have already gathered."
      })
    ]
  }
  const served = surface.serve(call, log, answering)
  if (served === undefined) {
    return [answering({ error: `unknown tool: ${call.name}. Call one of: ${surface.tools.map((t) => t.name).join(", ")}.` })]
  }
  return served
}

// toolsReactor is the default surface's reactor: code mode. An agent on another surface builds
// its own with `toolsReactorFor`.
export const toolsReactor: Reactor<never> = toolsReactorFor(codeSurface())
