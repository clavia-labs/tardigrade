import { Schema } from "effect"
import { EncodedReference, referenceLocator, type ValueReference } from "../value"
import type { Json } from "../storage/nodes"

export const DocumentState = Schema.TaggedStruct("DocumentState", { reference: EncodedReference })

// openReference upgrades legacy whole-document references while current references reopen directly (test/reducer/integration.test.ts).
export function openReference<Value>(reference: ValueReference<unknown>, target: {
  readonly scope: string
  readonly current: (reference: ValueReference<unknown>) => Value
  readonly read: (reference: ValueReference<unknown>) => Json
  readonly initial: (state: unknown) => Value
  readonly migrate?: ((state: unknown) => unknown) | undefined
}): Value {
  const selected = referenceLocator(reference, target.scope)
  if (selected.path.length || selected.each !== undefined || selected.range !== undefined) throw new Error("State requires whole-document reference")
  if (selected.backend === "reducer") return target.current(reference)
  const value = target.read(reference)
  return target.initial(target.migrate ? target.migrate(value) : value)
}
