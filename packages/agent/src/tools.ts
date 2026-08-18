import { Clock, Effect } from "effect"
import { transition, type Reactor, type Transition } from "@flamecast/core/actor"
import { budgetRequested, toolReturned } from "./events"
import { codeDispatched } from "@flamecast/code/events"
import type { Event } from "@flamecast/core/event"
import { turnView } from "@flamecast/code/turns"
import { budgetSpent } from "./budget"
import { answerErrors, outputSchemaOf, repairText } from "./contract"

// The tools reactor: the agent's side of the execute tool. `execute` is the only tool: the model
// interacts with the real world by writing code, and packages are objects in the code's scope.
// It translates between the agent's alphabet and the code reactor's: it dispatches the call's
// code, owes nothing while the code reactor executes, and answers the call with the settle.
// Neither imports the other.
//
// Owed work, derived from the event set: the head pending call (a ToolCalled with no
// ToolReturned, earliest by its own `at`) owes a routing until its dispatch or ask exists, an
// answer once its execution settled, and an escalation answer once the parent decided.

interface PendingCall {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly turn?: string
}

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

const settleFor = (
  log: ReadonlyArray<Event>,
  callId: string
): { result?: unknown; error?: string; logs?: ReadonlyArray<string> } | undefined => {
  const settle = log.find((e) => e.type === "CodeSettled" && str((e as { execId?: unknown }).execId) === callId) as
    | { result?: unknown; error?: unknown; logs?: ReadonlyArray<string>; tmp?: unknown; size?: unknown; preview?: unknown; note?: unknown }
    | undefined
  if (settle === undefined) return undefined
  // Captured console output rides along: the model reads what its code printed, beside the
  // result (the print-to-inspect habit; packages/code/src/sandbox.ts, SandboxResult.logs).
  const logs = settle.logs !== undefined && settle.logs.length > 0 ? { logs: settle.logs } : {}
  if (settle.error !== undefined) return { error: String(settle.error), ...logs }
  // A settle over TMP_BYTES carries a pointer instead of the value (packages/code/src/execute.ts).
  // The pointer IS the result the model reads: its preview and its note name the ref and the
  // call that loads it. Reading `result` alone answers a spilled call with `{}`, so the model
  // learns neither what it computed nor that anything is there to fetch, and it re-runs the work
  // it already did (tools.test.ts, "a spilled settle").
  if (settle.tmp !== undefined) {
    return { result: { tmp: settle.tmp, size: settle.size, preview: settle.preview, note: settle.note }, ...logs }
  }
  return { result: settle.result, ...logs }
}

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

// toolsReactor derives one transition per pending call, branch by branch. The records each
// branch appends carry the keys: an answer tr:<callId>, a dispatch cd:<callId>, an escalation
// ask br:<callId>. An escalating call with no parental decision derives nothing (the turn is
// durably paused); the decision's arrival re-derives the answer.
export const toolsReactor: Reactor<never> = (log) => {
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

  // Executed: answer the call with the settle, once it exists.
  if (has(log, "CodeDispatched", "execId", call.callId)) {
    const outcome = settleFor(log, call.callId)
    if (outcome === undefined) return []
    return [answering(outcome)]
  }

  // Route the call.
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
  if (call.name !== "execute") {
    return [answering({ error: `unknown tool: ${call.name}. Write code with execute.` })]
  }
  // The budget gate: the wall on the turn refuses the dispatch and keeps the model's work.
  if (budgetSpent(log)) {
    return [
      answering({
        error: "Tool budget reached. Do not call execute again. Call answer now with your best result from what you have already gathered."
      })
    ]
  }
  const code = String((call.arguments as { code?: unknown } | undefined)?.code ?? "")
  return [
    transition({
      key: `cd:${call.callId}`,
      input: { execId: call.callId, code },
      act: (input) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          return [codeDispatched({ execId: input.execId, code: input.code, ...stamp, at })]
        })
    })
  ]
}
