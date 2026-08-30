import { Schema } from "effect"
import { actorMethod } from "@clavia/tardigrade-core/actor/method"
import { permissionRequestReceived } from "../log/events"

export const PermissionRequestInput = Schema.Struct({
  request: Schema.String,
  turn: Schema.String,
  tool: Schema.String,
  action: Schema.String,
  resource: Schema.optionalKey(Schema.String),
  reason: Schema.String
}).annotate({ identifier: "PermissionRequestInput" })

export type PermissionRequestInput = typeof PermissionRequestInput.Type

export const PermissionDecision = Schema.Union([
  Schema.Struct({ granted: Schema.Literal(true) }),
  Schema.Struct({ denied: Schema.Literal(true), reason: Schema.optionalKey(Schema.String) })
]).annotate({ identifier: "PermissionDecision" })

export type PermissionDecision = typeof PermissionDecision.Type

// requestPermissionMethod exposes one-shot tool authorization as a unary actor call.
export const requestPermissionMethod = actorMethod({
  input: PermissionRequestInput,
  output: PermissionDecision,
  event: ({ invocation, input, at }) => permissionRequestReceived({ id: invocation.id, ...input, at }),
  state: (events, invocation) => {
    const { id } = invocation
    const received = events.some((event) =>
      event.type === "PermissionRequestReceived" && String((event as { readonly id?: unknown }).id) === id
    )
    if (!received) return undefined
    const decided = events.find((event) =>
      event.type === "PermissionRequestDecided" && String((event as { readonly callId?: unknown }).callId) === id
    ) as { readonly granted?: unknown; readonly reason?: unknown } | undefined
    const failed = events.find((event) =>
      event.type === "PermissionRequestFailed" && String((event as { readonly callId?: unknown }).callId) === id
    ) as { readonly error?: unknown } | undefined
    if (failed !== undefined) return { status: "failed", error: String(failed.error ?? "permission authority failed") }
    if (decided === undefined) return { status: "pending" }
    return decided.granted === true
      ? { status: "completed", output: { granted: true as const } }
      : {
          status: "completed",
          output: {
            denied: true as const,
            ...(typeof decided.reason === "string" && decided.reason !== "" ? { reason: decided.reason } : {})
          }
        }
  }
})
