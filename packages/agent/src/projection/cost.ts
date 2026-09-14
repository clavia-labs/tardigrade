import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { ModelPricing, priced, sumUsage, usageOf, type Usage } from "../inference/usage"

export interface Cost {
  readonly reportedUsd?: number
  readonly estimatedUsd?: number
}

export interface AttemptCost extends Cost {
  readonly callId: string
  readonly turn?: string
  readonly outcome: "pending" | "returned" | "failed"
}

export interface Costs {
  readonly attempts: ReadonlyArray<AttemptCost>
  readonly total: Cost
}

const amountsOf = (usage: Usage): Cost => ({
  ...(usage.reportedCostUsd === undefined ? {} : { reportedUsd: usage.reportedCostUsd }),
  ...(usage.estimatedCostUsd === undefined ? {} : { estimatedUsd: usage.estimatedCostUsd })
})

// costsOf projects one thread's ordered log using recorded prices; unanswered attempts keep totals unknown (cost.test.ts).
export const costsOf = (events: ReadonlyArray<Event>, options: { readonly turn?: string } = {}): Costs => {
  const indexed = new Map<string, { called?: Event; returned?: Event }>()
  for (const event of events) {
    if (event.type !== "ModelCalled" && event.type !== "ModelReturned") continue
    if (options.turn !== undefined && event.turn !== options.turn) continue
    const key = JSON.stringify([event.turn, event.callId])
    const attempt = indexed.get(key) ?? {}
    if (event.type === "ModelCalled") attempt.called = event
    else attempt.returned = event
    indexed.set(key, attempt)
  }
  const usages: Usage[] = []
  const attempts: AttemptCost[] = []
  for (const { called, returned } of indexed.values()) {
    const event = returned ?? called!
    const pricing = Schema.is(ModelPricing)(called?.pricing) ? called.pricing : undefined
    const usage = returned === undefined ? {} : priced(usageOf({
      ...usageOf(returned.legacyUsage ?? returned.usage),
      ...(returned.reportedCostUsd === undefined ? {} : { reportedCostUsd: returned.reportedCostUsd })
    }), pricing)
    usages.push(usage)
    attempts.push({
      callId: String(event.callId),
      ...(typeof event.turn === "string" ? { turn: event.turn } : {}),
      outcome: returned === undefined ? "pending" : returned.outcome === "failed" ? "failed" : "returned",
      ...amountsOf(usage)
    })
  }
  return { attempts, total: attempts.length === 0 ? { reportedUsd: 0, estimatedUsd: 0 } : amountsOf(sumUsage(usages)) }
}
