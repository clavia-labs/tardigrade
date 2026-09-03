import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { actorMethod } from "@clavia/tardigrade-core/method"
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

interface PermissionMethodProjection {
  readonly received: ReadonlySet<string>
  readonly decided: ReadonlyMap<string, { readonly granted?: unknown; readonly reason?: unknown }>
  readonly failed: ReadonlyMap<string, string>
}

const reducePermissionMethod = (state: PermissionMethodProjection, event: Event): PermissionMethodProjection => {
  const received = new Set(state.received)
  const decided = new Map(state.decided)
  const failed = new Map(state.failed)
  if (event.type === "PermissionRequestReceived") received.add(String((event as { readonly id?: unknown }).id ?? ""))
  if (event.type === "PermissionRequestDecided") {
    decided.set(
      String((event as { readonly callId?: unknown }).callId ?? ""),
      event as { readonly granted?: unknown; readonly reason?: unknown }
    )
  }
  if (event.type === "PermissionRequestFailed") {
    failed.set(
      String((event as { readonly callId?: unknown }).callId ?? ""),
      String((event as { readonly error?: unknown }).error ?? "permission authority failed")
    )
  }
  return { received, decided, failed }
}

const permissionStateFrom = (state: PermissionMethodProjection, id: string) => {
  if (!state.received.has(id)) return undefined
  const failure = state.failed.get(id)
  if (failure !== undefined) return { status: "failed" as const, error: failure }
  const decision = state.decided.get(id)
  if (decision === undefined) return { status: "pending" as const }
  return decision.granted === true
    ? { status: "completed" as const, output: { granted: true as const } }
    : {
        status: "completed" as const,
        output: {
          denied: true as const,
          ...(typeof decision.reason === "string" && decision.reason !== "" ? { reason: decision.reason } : {})
        }
      }
}

// requestPermissionMethod exposes one-shot tool authorization as a unary actor call.
export const requestPermissionMethod = actorMethod({
  input: PermissionRequestInput,
  output: PermissionDecision,
  event: ({ invocation, input, at }) => permissionRequestReceived({ id: invocation.id, ...input, at }),
  projection: {
    initial: (): PermissionMethodProjection => ({ received: new Set(), decided: new Map(), failed: new Map() }),
    step: reducePermissionMethod,
    output: (state) => ({
      currentEpoch: () => 0,
      invocationState: (invocation) => permissionStateFrom(state, invocation.id)
    })
  }
})
