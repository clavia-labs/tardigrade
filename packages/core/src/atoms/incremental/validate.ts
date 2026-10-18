import { incrementalValidator as groveValidator } from "@tardie/grove"
import type { Schema } from "effect"
import { frozenPlainData } from "./frozen"

export { invalid } from "@tardie/grove"

// incrementalValidator shares Grove's validator with Core's frozen-data proofs (platform/test/properties/runtime/state-validation.ts).
export const incrementalValidator = (schema: Schema.Top, onFallback?: () => void) => groveValidator(schema, onFallback, frozenPlainData)
