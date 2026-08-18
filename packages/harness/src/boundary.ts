import type { Event } from "@flamecast/core"

// A turn's boundary: where a settle left it. A turn ends in a terminal, it parks on a budget
// ask, or it defers a model call until a due time. Pure over the log, so a re-driven settle reads
// the same boundary.
//
// A parent reads this result from the event returned by `Router.call`. Core carries events and knows
// no domain, so the harness interprets the event with the alphabet that wrote it.

export type CallResult =
  | { readonly kind: "completed"; readonly output: string }
  | { readonly kind: "failed"; readonly error: string }
  | {
      readonly kind: "parked"
      readonly callId: string
      readonly reason: string
      readonly amount: number
    }
  | {
      readonly kind: "deferred"
      readonly callId: string
      readonly attempt: number
      readonly notBefore: number
      readonly reason: string
    }

const stampOf = (event: Event): string | undefined =>
  event.turn === undefined ? undefined : String(event.turn)

// The boundary of one turn, or undefined while it is still running. A terminal wins over a park: a
// turn that was granted more budget and then finished reads as completed even though it once asked.
// A park is the last `BudgetRequested` that no grant and no denial has answered.
export const boundaryOf = (log: ReadonlyArray<Event>, turn: string): CallResult | undefined => {
  const terminal = log.find(
    (event) =>
      (event.type === "TurnCompleted" || event.type === "TurnFailed") && stampOf(event) === turn
  )
  if (terminal !== undefined) {
    return terminal.type === "TurnCompleted"
      ? { kind: "completed", output: String(terminal.output ?? "") }
      : { kind: "failed", error: String(terminal.error ?? "") }
  }
  let pending: Event | undefined
  for (const event of log) {
    if (stampOf(event) !== turn) continue
    if (event.type === "BudgetRequested") pending = event
    else if (
      pending !== undefined &&
      (event.type === "BudgetGranted" || event.type === "BudgetDenied") &&
      String(event.callId ?? "") === String(pending.callId ?? "") &&
      (event.type === "BudgetDenied" ||
        (typeof event.amount === "number" && Number.isFinite(event.amount) && event.amount > 0))
    ) {
      pending = undefined
    }
  }
  if (pending !== undefined) {
    return {
      kind: "parked",
      callId: String(pending.callId ?? ""),
      reason: String(pending.reason ?? ""),
      amount: Number(pending.amount ?? 0)
    }
  }
  // A deferral is the last model wait that no wake and no later attempt has answered.
  for (let index = log.length - 1; index >= 0; index--) {
    const event = log[index]
    if (event === undefined || stampOf(event) !== turn) continue
    if (event.type === "ModelDeferred") {
      return {
        kind: "deferred",
        callId: String(event.callId ?? ""),
        attempt: Number(event.attempt ?? 0),
        notBefore: Number(event.notBefore ?? 0),
        reason: String(event.reason ?? "")
      }
    }
    if (
      event.type === "AlarmFired" ||
      event.type === "ModelReturned" ||
      event.type === "ModelCalled" ||
      event.type === "ToolCalled"
    ) {
      break
    }
  }
  return undefined
}
