import { durableAtom } from "@clavia/tardigrade-experimental-core"
import { Schema } from "effect"
import { BudgetConfigured, BudgetUpdated, BudgetResolved, ModelCalled, TurnSettled } from "../../event"
import { BudgetState, budgetState as reduceBudget } from "../../projections"

export const budgetState = durableAtom({
  name: "agent.budget",
  input: Schema.Union([BudgetConfigured, BudgetUpdated, BudgetResolved, ModelCalled, TurnSettled]),
  schema: BudgetState, initial: [], reduce: reduceBudget,
})
