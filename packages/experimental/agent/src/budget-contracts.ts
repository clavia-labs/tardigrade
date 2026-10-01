import { Schema } from "effect"

export const ToolBudgetAmount = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

export const ToolBudgetRequestInput = Schema.Struct({ amount: ToolBudgetAmount, reason: Schema.NonEmptyString })
