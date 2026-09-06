import { Schema } from "effect"
import type { Event } from "../event"
import { invocationCoordinateKey, type InvocationCoordinate } from "./invocation"
import type { ResponseReceived, CallTimedOut } from "./events"

import type { ActorMethodState } from "./state"
import { terminalInvocationRefOf } from "./records-compat"
export { terminalInvocationRefOf } from "./records-compat"

// invocationTerminalOf reads a terminal belonging to the exact target and invocation (result.test.ts).
export const invocationTerminalOf = (
  events: ReadonlyArray<Event>,
  reference: InvocationCoordinate
): ResponseReceived | CallTimedOut | undefined => events.find((event) => {
  const terminal = terminalInvocationRefOf(event)
  return terminal !== undefined && invocationCoordinateKey(terminal) === invocationCoordinateKey(reference)
}) as ResponseReceived | CallTimedOut | undefined

// invocationResultOf decodes a matching terminal without discarding its output contract metadata.
export const invocationResultOf = <Output>(
  terminal: ResponseReceived | CallTimedOut,
  output: Schema.ConstraintDecoder<Output>
): ActorMethodState<Output> => {
  if (terminal.type === "CallTimedOut") return { status: "failed", error: `${terminal.method} timed out after ${terminal.timeoutMs}ms` }
  const data = terminal.data === undefined ? {} : { data: terminal.data }
  if (terminal.status === "failed") return { status: "failed", error: terminal.error ?? "actor method failed", ...data }
  if (terminal.status === "cancelled") return {
    status: "cancelled", cause: terminal.cause ?? "requested",
    ...(terminal.reason === undefined ? {} : { reason: terminal.reason }),
    ...(terminal.deadlineAt === undefined ? {} : { deadlineAt: terminal.deadlineAt }), ...data
  }
  try {
    return { status: "completed", output: Schema.decodeUnknownSync(output)(terminal.output), ...data }
  } catch (failure) {
    return { status: "failed", error: `invalid ${terminal.method} response: ${failure instanceof Error ? failure.message : String(failure)}`, ...data }
  }
}
