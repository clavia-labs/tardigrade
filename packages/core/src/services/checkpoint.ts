import { Schema, Crypto, Effect, Encoding, PlatformError } from "effect"
import { RuntimeError, ExecutionResult, effectKey } from "../runtime/effects"
import { StoredOperation, operationSettlement, cleanupSucceeded } from "../runtime/operation"
import type { EffectCheckpoint } from "../runtime/replay"
import { migrateCheckpoint } from "./checkpoint/migrations"

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
    encoded = JSON.stringify({ version: 3, ...checkpoint })
  } catch (cause) {
    throw new Error("Checkpoint state is not serializable", { cause })
  }
  return new TextEncoder().encode(encoded)
}

export const decodeCheckpoint = (bytes: Uint8Array): EffectCheckpoint => {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid checkpoint payload")
  const record = migrateCheckpoint(value as Record<string, unknown>)
  if (!Number.isSafeInteger(record.position) || (record.position as number) < 0 ||
    !Array.isArray(record.durable)) throw new Error("Invalid checkpoint payload")
  const durable = record.durable.map(entry => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("Invalid durable checkpoint entry")
    const item = entry as Record<string, unknown>
    if (typeof item.name !== "string" || !item.name || !Number.isSafeInteger(item.position) || (item.position as number) < 0 || item.state === undefined) throw new Error("Invalid durable checkpoint entry")
    if (item.position !== record.position) throw new Error("Durable entry position differs from checkpoint position")
    return { name: item.name, state: item.state, position: item.position as number }
  })
  if (!Array.isArray(record.operations)) throw new Error("Invalid checkpoint operations")
  const operations = record.operations.map(entry => Schema.decodeUnknownSync(StoredOperation)(entry))
  const references = new Set<string>()
  for (const operation of operations) {
    const { ref, request, execution, cleanup } = operation
    const key = effectKey(ref)
    if (references.has(key)) throw new Error("Duplicate checkpoint operation")
    references.add(key)
    if ([request, execution.outcome, execution.deferred, execution.promise, execution.retry, cleanup?.request, cleanup?.outcome, cleanup?.retry].some(event => event && effectKey(event.ref) !== key)) throw new Error("Effect checkpoint references disagree")
    if (execution.retry?.phase === "cancellation" || (cleanup?.retry && cleanup.retry.phase !== "cancellation")) throw new Error("Checkpoint retry phase disagrees with lifecycle")
    const settlement = operationSettlement(operation)
    if (execution.outcome?.type === "EffectDied") throw new Error("Checkpoint cannot contain a terminal thread defect")
    if (!settlement && !cleanup) throw new Error("Effect checkpoint contains pending work")
    if (execution.promise && settlement?.outcome.status !== "fulfilled") throw new Error("Promise checkpoint requires successful execution")
    if (!cleanup && settlement?.outcome.status === "fulfilled" && Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value).type === "promise" && !execution.promise) throw new Error("Effect checkpoint contains a pending promise")
    if (cleanup && !cleanupSucceeded(cleanup.outcome) && request.request.input._tag !== "InlineInput") throw new Error("Cancellation checkpoint requires inline input")
  }
  return { position: record.position as number, durable, operations }
}
