import type { Event } from "@clavia/tardigrade-core/event"
import { turnTerminalOf } from "@clavia/tardigrade-code/turns"
import { decodeOutput, type OutputContract } from "./output"

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
  const terminal = turnTerminalOf(log, turn)
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

// outputOf reads a finished turn's answer as the value its contract declares. It is a projection
// like every other reader here: undefined while the turn runs or once it failed, and the decoded
// value on a completed one.
//
// A recorded completion is validated before it lands (runtime/infer.ts, completionOf), so one
// that misses its contract here is a log written by something that did not go through that path.
// That throws rather than reading as absent: an answer nobody can trust is worse than a turn
// that plainly has none.
export const outputOf = <T>(
  contract: OutputContract<T>,
  log: ReadonlyArray<Event>,
  turn: string
): T | undefined => {
  const terminal = turnTerminalOf(log, turn)
  if (terminal === undefined || terminal.type !== "TurnCompleted") return undefined
  const decoded = decodeOutput(contract, String((terminal as { output?: unknown }).output))
  if (decoded.errors.length > 0) {
    throw new Error(
      `turn ${turn} completed with an answer that misses the contract "${contract.name}":\n${decoded.errors.map((e) => `- ${e}`).join("\n")}`
    )
  }
  return decoded.value as T
}
