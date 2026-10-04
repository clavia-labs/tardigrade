import { Schema, Crypto, Effect, Encoding, PlatformError } from "effect"
import { RuntimeError, EffectRef, EffectCancelled } from "../runtime/effects"
import { StoredEffectRequested, EffectSettled, PromiseSettled } from "../runtime/events"
import type { EffectCheckpoint } from "../runtime/replay"

export const DEFAULT_CHECKPOINT_MAX_BYTES = 256 * 1024 * 1024

const crypto = Crypto.make({
  randomBytes: size => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) => Effect.tryPromise({ try: () => globalThis.crypto.subtle.digest(algorithm, data.slice().buffer as ArrayBuffer).then(value => new Uint8Array(value)), catch: cause => PlatformError.systemError({ _tag: "Unknown", module: "Crypto", method: "digest", description: "Checkpoint digest failed", cause }) }),
})

export const checkpointDigest = (payload: Uint8Array): Effect.Effect<string, RuntimeError> => crypto.digest("SHA-256", payload).pipe(Effect.map(Encoding.encodeHex), Effect.mapError(RuntimeError.from))

export const encodeCheckpoint = (checkpoint: EffectCheckpoint): Uint8Array => {
  if (!Number.isSafeInteger(checkpoint.position) || checkpoint.position < 0) throw new Error("Invalid checkpoint position")
  if (checkpoint.durable.some(entry => entry.position !== checkpoint.position)) throw new Error("Durable entry position differs from checkpoint position")
  if (checkpoint.durable.some(entry => !Schema.is(Schema.Json)(entry.state))) throw new Error("Checkpoint state must be JSON")
  let encoded: string
  try {
    encoded = JSON.stringify({ version: 2, ...checkpoint })
  } catch (cause) {
    throw new Error("Checkpoint state is not serializable", { cause })
  }
  return new TextEncoder().encode(encoded)
}

export const decodeCheckpoint = (bytes: Uint8Array): EffectCheckpoint => {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid checkpoint payload")
  const record = value as Record<string, unknown>
  if (record.version !== 2 || !Number.isSafeInteger(record.position) || (record.position as number) < 0 ||
    !Array.isArray(record.durable) || !Array.isArray(record.effects) || !Array.isArray(record.promises)) throw new Error("Invalid checkpoint payload")
  const durable = record.durable.map(entry => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("Invalid durable checkpoint entry")
    const item = entry as Record<string, unknown>
    if (typeof item.name !== "string" || !item.name || !Number.isSafeInteger(item.position) || (item.position as number) < 0 || item.state === undefined) throw new Error("Invalid durable checkpoint entry")
    if (item.position !== record.position) throw new Error("Durable entry position differs from checkpoint position")
    return { name: item.name, state: item.state, position: item.position as number }
  })
  const effects = record.effects.map(entry => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("Invalid effect checkpoint entry")
    const item = entry as Record<string, unknown>
    const ref = Schema.decodeUnknownSync(EffectRef)(item.ref)
    const request = Schema.decodeUnknownSync(StoredEffectRequested)(item.request)
    const settlement = item.settlement === undefined ? undefined : Schema.decodeUnknownSync(Schema.toType(EffectSettled))(item.settlement)
    const cancellation = item.cancellation === undefined ? undefined : Schema.decodeUnknownSync(EffectCancelled)(item.cancellation)
    if (!settlement && !cancellation) throw new Error("Effect checkpoint contains pending work")
    if (cancellation && request.request.input._tag !== "InlineInput") throw new Error("Cancellation checkpoint requires inline input")
    if ([request, settlement, cancellation].some(record => record && JSON.stringify(ref) !== JSON.stringify(record.ref))) throw new Error("Effect checkpoint references disagree")
    return { ref, request, ...(settlement ? { settlement } : {}), ...(cancellation ? { cancellation } : {}) }
  })
  const promises = record.promises.map(entry => Schema.decodeUnknownSync(Schema.toType(PromiseSettled))(entry))
  return { position: record.position as number, durable, effects, promises }
}
