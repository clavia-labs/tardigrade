import type { Event } from "@clavia/tardigrade-core/event"
import { turnTerminalOf } from "@clavia/tardigrade-code/turns"
import { canonicalOf, declarationForTurn, type OutputContract } from "./output"

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
// The turn must have declared this contract. Holding a contract is not evidence that the answer
// was produced under it, and a reader that skipped the check would reinterpret prose that happens
// to parse as the shape it wanted (boundary.test.ts, "a turn that declared nothing is never
// reinterpreted"). The comparison is the canonical form of the declaration recorded on the turn's
// head against the canonical form of the contract in hand, so a second schema wearing the same
// name is a different contract (output.ts, canonicalOf).
//
// A recorded completion is validated before it lands (runtime/infer.ts, completionOf), so one
// that misses its contract here is a log written by something that did not go through that path.
// Both mismatches throw rather than reading as absent: an answer nobody can trust is worse than a
// turn that plainly has none.
export const outputOf = <T>(
  contract: OutputContract<T>,
  log: ReadonlyArray<Event>,
  turn: string
): T | undefined => {
  const terminal = turnTerminalOf(log, turn)
  if (terminal === undefined || terminal.type !== "TurnCompleted") return undefined
  const declared = declarationForTurn(log, turn)
  if (declared.kind !== "contract") {
    throw new Error(
      `turn ${turn} did not declare the contract "${contract.name}", so its answer is not a value of that contract` +
        (declared.kind === "invalid" ? `: ${declared.errors.join("; ")}` : "")
    )
  }
  if (canonicalOf(declared.contract) !== canonicalOf(contract)) {
    throw new Error(
      `turn ${turn} declared the contract "${declared.contract.name}", which is not the contract "${contract.name}" this read holds`
    )
  }
  const decoded = declared.contract.decode(JSON.parse(String((terminal as { output?: unknown }).output)))
  if ("errors" in decoded) {
    throw new Error(
      `turn ${turn} completed with an answer that misses the contract "${contract.name}":\n${decoded.errors.map((e) => `- ${e}`).join("\n")}`
    )
  }
  return decoded.value as T
}
