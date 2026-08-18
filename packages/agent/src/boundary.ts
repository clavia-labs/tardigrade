import type { Event } from "@flamecast/core/event"

// Boundary is where a settle left a turn: a terminal, or a park on a budget ask. The
// platform's call and resume read it to answer the spawning code. Pure over the log, so a
// re-driven settle reads the same boundary.

export type Boundary =
  | { readonly kind: "completed"; readonly output: string }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "requesting"; readonly callId: string; readonly reason: string; readonly amount: number }

// boundaryOf returns the turn's boundary, or undefined while it still runs. A terminal wins
// over a park: a resumed turn that finished reads completed even though it once asked. A park
// is the last BudgetRequested no grant or denial has answered.
export const boundaryOf = (log: ReadonlyArray<Event>, turn: string): Boundary | undefined => {
  const terminal = log.find(
    (e) => (e.type === "TurnCompleted" || e.type === "TurnFailed") && String((e as { turn?: unknown }).turn) === turn
  )
  if (terminal !== undefined) {
    return terminal.type === "TurnCompleted"
      ? { kind: "completed", output: String((terminal as { output?: unknown }).output) }
      : { kind: "failed", error: String((terminal as { error?: unknown }).error) }
  }
  let pending: Event | undefined
  for (const e of log) {
    if (String((e as { turn?: unknown }).turn) !== turn) continue
    if (e.type === "BudgetRequested") pending = e
    else if (e.type === "BudgetGranted" || e.type === "BudgetDenied") pending = undefined
  }
  if (pending !== undefined) {
    const p = pending as { callId?: unknown; reason?: unknown; amount?: unknown }
    return { kind: "requesting", callId: String(p.callId), reason: String(p.reason ?? ""), amount: Number(p.amount ?? 0) }
  }
  return undefined
}
