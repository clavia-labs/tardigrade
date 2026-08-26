import type { Event } from "@clavia/tardigrade-core/log/event"
import { turnTerminalOf } from "@clavia/tardigrade-code/execution/turns"
import { canonicalOf, declarationForTurn, type OutputContract } from "./contract"

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

// outputOf reads a completed turn's result under the contract that turn declared. It returns undefined for a pending or failed turn and throws when the declaration or stored result cannot satisfy the supplied contract (boundary.test.ts, "a turn that declared nothing is never reinterpreted"; inference/reactor.ts, completionOf).
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
      `turn ${turn} did not declare the contract "${contract.name}", so its result is not a value of that contract` +
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
      `turn ${turn} completed with a result that misses the contract "${contract.name}":\n${decoded.errors.map((e) => `- ${e}`).join("\n")}`
    )
  }
  return decoded.value as T
}
