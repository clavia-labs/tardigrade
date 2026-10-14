import { Schema } from "effect"
import { EffectRef, EffectCancelled, effectKey } from "../../runtime/effects"
import { StoredEffectRequested, EffectSettled, PromiseSettled } from "../../runtime/events"
import type { StoredOperation } from "../../runtime/operation"

// migrateCheckpoint upgrades version-2 payloads to nested operations before current-schema validation (platform/test/properties/runtime/pending-input-recovery.ts).
export function migrateCheckpoint(record: Record<string, unknown>): Record<string, unknown> {
  if (record.version === 3) return record
  if (record.version !== 2) throw new Error("Invalid checkpoint payload")
  if (!Array.isArray(record.effects) || !Array.isArray(record.promises)) throw new Error("Invalid checkpoint payload")
  const legacy = Schema.Struct({
    ref: EffectRef, request: StoredEffectRequested,
    settlement: Schema.optionalKey(Schema.toType(EffectSettled)), cancellation: Schema.optionalKey(EffectCancelled),
  })
  const operations: StoredOperation[] = record.effects.map(entry => {
    const item = Schema.decodeUnknownSync(legacy)(entry)
    return { ref: item.ref, request: item.request, execution: item.settlement ? { outcome: item.settlement } : {},
      ...(item.cancellation ? { cleanup: { request: item.cancellation } } : {}) }
  })
  for (const entry of record.promises) {
    const promise = Schema.decodeUnknownSync(Schema.toType(PromiseSettled))(entry)
    const index = operations.findIndex(operation => effectKey(operation.ref) === effectKey(promise.ref))
    if (index === -1) throw new Error("Promise checkpoint requires an accepted operation")
    const operation = operations[index]!
    if (operation.execution.promise) throw new Error("Duplicate checkpoint promise")
    operations[index] = { ...operation, execution: { ...operation.execution, promise } }
  }
  return { version: 3, position: record.position, durable: record.durable, operations }
}
