import { Schema } from "effect"

export const BudgetAmount = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

export const BudgetRequestInput = Schema.Struct({ amount: BudgetAmount, reason: Schema.NonEmptyString })
