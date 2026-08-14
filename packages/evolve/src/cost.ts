import type { Event } from "@flamecast/core"
import type { Usage } from "@flamecast/harness/infer"
import { toolCallsOf } from "@flamecast/harness/modules/budget"
import { spendOf } from "./score"

export interface EvolutionCost extends Usage {
  readonly toolCalls: number
}

export interface Costed<Value> {
  readonly value: Value
  readonly cost: EvolutionCost
}

export const zeroEvolutionCost = (): EvolutionCost => ({
  promptTokens: 0,
  completionTokens: 0,
  costUsd: 0,
  toolCalls: 0
})

const validateEvolutionCost = (cost: EvolutionCost) => {
  for (const field of ["promptTokens", "completionTokens", "costUsd", "toolCalls"] as const) {
    if (!Number.isFinite(cost[field]) || cost[field] < 0) {
      throw new Error(`evolution cost ${field} must be a non-negative finite number`)
    }
  }
}

export const sumEvolutionCosts = (
  costs: ReadonlyArray<EvolutionCost>
): EvolutionCost =>
  costs.reduce((total, cost) => {
    validateEvolutionCost(cost)
    const combined = {
      promptTokens: total.promptTokens + cost.promptTokens,
      completionTokens: total.completionTokens + cost.completionTokens,
      costUsd: total.costUsd + cost.costUsd,
      toolCalls: total.toolCalls + cost.toolCalls
    }
    validateEvolutionCost(combined)
    return combined
  }, zeroEvolutionCost())

export const evolutionCostOf = (
  ...logs: ReadonlyArray<ReadonlyArray<Event>>
): EvolutionCost =>
  sumEvolutionCosts(
    logs.map((log) => ({
      ...spendOf(log),
      toolCalls: toolCallsOf(log)
    }))
  )

export const costed = <Value>(
  value: Value,
  ...logs: ReadonlyArray<ReadonlyArray<Event>>
): Costed<Value> => ({ value, cost: evolutionCostOf(...logs) })
