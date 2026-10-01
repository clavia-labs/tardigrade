import { durableAtom, RuntimeError } from "@clavia/tardigrade-experimental-core"
import { Schema } from "effect"
import { BudgetConfigured, BudgetUpdated, BudgetResolved, ModelCalled, TurnSettled, BudgetDecision, BudgetPolicy, BudgetMetric, type Event } from "../../contracts/events"

export const BudgetState = Schema.Array(Schema.Struct({
  metric: BudgetMetric, turnId: Schema.optionalKey(Schema.String), policy: BudgetPolicy, granted: Schema.Finite,
  decisions: Schema.Array(Schema.Struct({ callId: Schema.String, decision: BudgetDecision })),
}))

function validateBudgetAmount(metric: string, amount: number) {
  if (!Number.isFinite(amount) || (metric === "toolCalls" && !Number.isSafeInteger(amount))) throw new RuntimeError(`Invalid budget amount for ${metric}`)
}

export function reduceBudget(state: typeof BudgetState.Type, event: Event): typeof BudgetState.Type {
  if (event.type === "BudgetConfigured" || event.type === "BudgetUpdated") {
    const prior = state.find(entry => entry.metric === event.metric)
    if (event.type === "BudgetConfigured" && prior) throw new RuntimeError(`Budget policy is already configured: ${event.metric}`)
    if (event.type === "BudgetUpdated" && !prior) throw new RuntimeError(`Budget policy is not configured: ${event.metric}`)
    validateBudgetAmount(event.metric, event.policy.limit)
    validateBudgetAmount(event.metric, event.policy.limit + (prior?.granted ?? 0))
    return prior ? state.map(entry => entry === prior ? { ...entry, policy: event.policy } : entry)
      : [...state, { metric: event.metric, policy: event.policy, granted: 0, decisions: [] }]
  }
  if (event.type === "ModelCalled" && event.purpose === "inference") {
    if (!state.some(entry => entry.turnId !== event.turnId)) return state
    return state.map(entry => entry.turnId !== event.turnId
      ? { ...entry, turnId: event.turnId, granted: 0, decisions: [] } : entry)
  }
  if (event.type === "TurnSettled") {
    if (!state.some(entry => entry.turnId === event.turnId)) return state
    return state.map(entry => {
      if (entry.turnId !== event.turnId) return entry
      const { turnId: _turnId, ...retained } = entry
      return { ...retained, granted: 0, decisions: [] }
    })
  }
  if (event.type === "BudgetResolved") {
    const budget = state.find(entry => entry.metric === event.metric)
    if (!budget) throw new RuntimeError(`Budget policy is not configured: ${event.metric}`)
    const prior = budget.decisions.find(value => value.callId === event.callId)
    if (prior) {
      const same = prior.decision.allowed
        ? event.decision.allowed && prior.decision.additional === event.decision.additional
        : !event.decision.allowed && prior.decision.reason === event.decision.reason
      if (!same) throw new RuntimeError(`Conflicting budget resolution: ${event.metric}:${event.callId}`)
      return state
    }
    if (event.decision.allowed) validateBudgetAmount(event.metric, event.decision.additional)
    const granted = budget.granted + (event.decision.allowed ? event.decision.additional : 0)
    validateBudgetAmount(event.metric, granted)
    validateBudgetAmount(event.metric, granted + budget.policy.limit)
    return state.map(entry => entry === budget ? { ...entry, granted, decisions: [...entry.decisions, { callId: event.callId, decision: event.decision }] } : entry)
  }
  return state
}

export const budgetState = durableAtom({
  name: "agent.budget",
  input: Schema.Union([BudgetConfigured, BudgetUpdated, BudgetResolved, ModelCalled, TurnSettled]),
  schema: BudgetState, initial: [], reduce: reduceBudget,
})
