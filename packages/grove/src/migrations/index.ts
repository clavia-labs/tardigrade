import { Schema } from "effect"
import { openInline, readInline, type InlineTarget } from "./inline"
import { DocumentState } from "./merkle"

export { ValueState } from "./inline"
export { DocumentState, openReference } from "./merkle"
const referenced = Schema.is(DocumentState)

// open restores saved materialised state through its format reader (core/properties/collections.test.ts; platform/test/properties/actors.ts).
export function open<Value>(stored: unknown, target: InlineTarget<Value> & { readonly reference: (reference: string) => Value }): Value {
  return referenced(stored) ? target.reference(stored.reference) : openInline(stored, target)
}

// read resolves saved state for cross-atom initialization without publishing a replacement (platform/test/bun/agent-compaction.test.ts).
export function read(stored: unknown, reference: (reference: string) => unknown): unknown {
  return referenced(stored) ? reference(stored.reference) : readInline(stored)
}
