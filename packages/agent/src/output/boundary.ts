import type { Event } from "@clavia/tardigrade-core/log/event"
import { turnEpochOf, turnTerminalOf } from "@clavia/tardigrade-code/execution/turns"
import { canonicalOf, declarationForTurn, type OutputContract } from "./contract"

// Boundary is where a settle left a turn: a terminal, a budget ask, or a schema-shaped human ask. The
// platform's call and resume read it to answer the spawning code. Pure over the log, so a
// re-driven settle reads the same boundary.

export type BudgetAsk = {
  readonly kind: "budget"
  readonly callId: string
  readonly reason: string
  readonly amount: number
}

export type SchemaAsk = {
  readonly kind: "schema"
  readonly callId: string
  readonly prompt: string
  readonly schema: unknown
}

export type TurnAsk = BudgetAsk | SchemaAsk

export type Boundary =
  | { readonly kind: "completed"; readonly output: string }
  | { readonly kind: "failed"; readonly error: string }
  | {
      readonly kind: "cancelled"
      readonly cause: "requested" | "deadline"
      readonly reason?: string
      readonly deadlineAt?: number
    }
  | { readonly kind: "requesting"; readonly callId: string; readonly reason: string; readonly amount: number }
  | { readonly kind: "asking"; readonly callId: string; readonly prompt: string; readonly schema: unknown }

export type TurnStatus = "pending" | "completed" | "failed" | "cancelled" | "parked"

export type TurnSnapshot = {
  readonly turn: string
  readonly status: TurnStatus
  readonly epoch: number
  readonly output?: string
  readonly error?: string
  readonly reason?: string
  readonly ask?: TurnAsk
}

const field = (event: Event, name: string): unknown => (event as Record<string, unknown>)[name]

const pendingAskOf = (log: ReadonlyArray<Event>, turn: string): Event | undefined => {
  let pending: Event | undefined
  for (const e of log) {
    if (String(field(e, "turn") ?? "") !== turn) continue
    if (e.type === "BudgetRequested" || e.type === "AskRequested") pending = e
    else if (e.type === "BudgetGranted" || e.type === "BudgetDenied") {
      if (pending?.type === "BudgetRequested") pending = undefined
    } else if (e.type === "AskAnswered" || e.type === "AskDenied") {
      if (pending?.type === "AskRequested") pending = undefined
    }
  }
  return pending
}

// parkedBoundary reports whether a boundary is an unanswered budget or human ask.
export const parkedBoundary = (boundary: Boundary | undefined): boolean =>
  boundary?.kind === "requesting" || boundary?.kind === "asking"

// boundaryOf returns the turn's boundary, or undefined while it still runs. A terminal wins
// over a park: a resumed turn that finished reads completed even though it once asked. A park
// is the last BudgetRequested or AskRequested that no BudgetGranted, BudgetDenied, AskAnswered, or AskDenied has closed.
export const boundaryOf = (log: ReadonlyArray<Event>, turn: string): Boundary | undefined => {
  const terminal = turnTerminalOf(log, turn)
  if (terminal !== undefined) {
    if (terminal.type === "TurnCompleted") {
      return { kind: "completed", output: String((terminal as { output?: unknown }).output) }
    }
    if (terminal.type === "TurnCancelled") {
      const cancelled = terminal as { cause?: unknown; reason?: unknown; deadlineAt?: unknown }
      return {
        kind: "cancelled",
        cause: cancelled.cause === "deadline" ? "deadline" : "requested",
        ...(typeof cancelled.reason === "string" && cancelled.reason !== "" ? { reason: cancelled.reason } : {}),
        ...(typeof cancelled.deadlineAt === "number" ? { deadlineAt: cancelled.deadlineAt } : {})
      }
    }
    return { kind: "failed", error: String((terminal as { error?: unknown }).error) }
  }
  const pending = pendingAskOf(log, turn)
  if (pending === undefined) return undefined
  if (pending.type === "AskRequested") {
    const p = pending as { callId?: unknown; prompt?: unknown; schema?: unknown }
    return { kind: "asking", callId: String(p.callId), prompt: String(p.prompt ?? ""), schema: p.schema }
  }
  const p = pending as { callId?: unknown; reason?: unknown; amount?: unknown }
  return { kind: "requesting", callId: String(p.callId), reason: String(p.reason ?? ""), amount: Number(p.amount ?? 0) }
}

const askOf = (boundary: Boundary): TurnAsk | undefined => {
  if (boundary.kind === "requesting") {
    return { kind: "budget", callId: boundary.callId, reason: boundary.reason, amount: boundary.amount }
  }
  if (boundary.kind === "asking") {
    return { kind: "schema", callId: boundary.callId, prompt: boundary.prompt, schema: boundary.schema }
  }
  return undefined
}

// turnViewOf projects one turn into the client TurnView shape, including a parked ask (client/src/contract.ts, TurnView).
export const turnViewOf = (log: ReadonlyArray<Event>, turn: string): TurnSnapshot => {
  const epoch = turnEpochOf(log, turn)
  const boundary = boundaryOf(log, turn)
  if (boundary === undefined) return { turn, status: "pending", epoch }
  if (boundary.kind === "completed") return { turn, status: "completed", epoch, output: boundary.output }
  if (boundary.kind === "failed") return { turn, status: "failed", epoch, error: boundary.error }
  if (boundary.kind === "cancelled") {
    return {
      turn,
      status: "cancelled",
      epoch,
      ...(boundary.reason === undefined ? {} : { reason: boundary.reason })
    }
  }
  const ask = askOf(boundary)
  return { turn, status: "parked", epoch, ...(ask === undefined ? {} : { ask }) }
}

// turnsOf lists every MessageReceived as a TurnView in log order (boundary.test.ts).
export const turnsOf = (log: ReadonlyArray<Event>): ReadonlyArray<TurnSnapshot> =>
  log
    .filter((event) => event.type === "MessageReceived")
    .map((event) => turnViewOf(log, String((event as { readonly id?: unknown }).id ?? "")))

// outputOf reads a completed turn's result under the contract that turn declared. It returns undefined for a pending or failed turn and throws when the declaration or stored result cannot satisfy the supplied contract (boundary.test.ts, "a turn that declared nothing is never reinterpreted"; inference/machine.ts, completionOf).
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
