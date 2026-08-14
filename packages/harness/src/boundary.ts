import type { Event } from "@flamecast/core"

// A turn's boundary: where a settle left it. A turn ends in a terminal, or it parks on a budget
// ask. Pure over the log, so a re-driven settle reads the same boundary.
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
    else if (event.type === "BudgetGranted" || event.type === "BudgetDenied") pending = undefined
  }
  if (pending === undefined) return undefined
  return {
    kind: "parked",
    callId: String(pending.callId ?? ""),
    reason: String(pending.reason ?? ""),
    amount: Number(pending.amount ?? 0)
  }
}
