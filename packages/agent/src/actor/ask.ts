import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { actorMethod } from "@clavia/tardigrade-core/actor/method"
import { askRequestReceived } from "../log/events"

export const AskRequestInput = Schema.Struct({
  request: Schema.String,
  turn: Schema.String,
  prompt: Schema.String,
  schema: Schema.Unknown
}).annotate({ identifier: "AskRequestInput" })

export type AskRequestInput = typeof AskRequestInput.Type

export const AskDecision = Schema.Union([
  Schema.Struct({ answered: Schema.Unknown }),
  Schema.Struct({ denied: Schema.Literal(true), reason: Schema.optionalKey(Schema.String) })
]).annotate({ identifier: "AskDecision" })

export type AskDecision = typeof AskDecision.Type

interface AskMethodProjection {
  readonly received: ReadonlySet<string>
  readonly decided: ReadonlyMap<string, { readonly denied?: unknown; readonly answer?: unknown; readonly reason?: unknown }>
  readonly failed: ReadonlyMap<string, string>
}

const reduceAskMethod = (state: AskMethodProjection, event: Event): AskMethodProjection => {
  const received = new Set(state.received)
  const decided = new Map(state.decided)
  const failed = new Map(state.failed)
  if (event.type === "AskRequestReceived") received.add(String((event as { readonly id?: unknown }).id ?? ""))
  if (event.type === "AskRequestDecided") {
    decided.set(
      String((event as { readonly callId?: unknown }).callId ?? ""),
      event as { readonly denied?: unknown; readonly answer?: unknown; readonly reason?: unknown }
    )
  }
  if (event.type === "AskRequestFailed") {
    failed.set(
      String((event as { readonly callId?: unknown }).callId ?? ""),
      String((event as { readonly error?: unknown }).error ?? "ask authority failed")
    )
  }
  return { received, decided, failed }
}

const askStateFrom = (state: AskMethodProjection, id: string) => {
  if (!state.received.has(id)) return undefined
  const failure = state.failed.get(id)
  if (failure !== undefined) return { status: "failed" as const, error: failure }
  const decision = state.decided.get(id)
  if (decision === undefined) return { status: "pending" as const }
  return decision.denied === true
    ? {
        status: "completed" as const,
        output: {
          denied: true as const,
          ...(typeof decision.reason === "string" && decision.reason !== "" ? { reason: decision.reason } : {})
        }
      }
    : { status: "completed" as const, output: { answered: decision.answer } }
}

// requestAskMethod exposes one schema-shaped human question as a unary actor call.
export const requestAskMethod = actorMethod({
  input: AskRequestInput,
  output: AskDecision,
  event: ({ invocation, input, at }) => askRequestReceived({ id: invocation.id, ...input, at }),
  projection: {
    initial: (): AskMethodProjection => ({ received: new Set(), decided: new Map(), failed: new Map() }),
    step: reduceAskMethod,
    output: (state) => ({
      currentEpoch: () => 0,
      invocationState: (invocation) => askStateFrom(state, invocation.id)
    })
  }
})
