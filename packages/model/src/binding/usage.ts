import type { Response } from "effect/unstable/ai"
import { priced, type ModelPricing, type Usage } from "@clavia/tardigrade-agent/inference/usage"

export type ReportedCostReader = (finish: Response.FinishPart) => number | undefined

// responseUsageOf maps Effect's inclusive token counts without interpreting raw provider fields (binding/usage.test.ts).
export const responseUsageOf = (finish: Response.FinishPart, stamp: { readonly provider: string; readonly model: string }, pricing?: ModelPricing, reportedCostUsd?: number): Usage => {
  const { inputTokens: input, outputTokens: output } = finish.usage
  return priced({
    ...stamp,
    ...(input.total === undefined ? {} : { promptTokens: input.total }),
    ...(output.total === undefined ? {} : { completionTokens: output.total }),
    ...(input.total === undefined || output.total === undefined ? {} : { totalTokens: input.total + output.total }),
    ...(input.cacheRead === undefined ? {} : { cachedPromptTokens: input.cacheRead }),
    ...(input.cacheWrite === undefined ? {} : { cacheWritePromptTokens: input.cacheWrite }),
    ...(output.reasoning === undefined ? {} : { reasoningTokens: output.reasoning }),
    ...(reportedCostUsd === undefined ? {} : { reportedCostUsd }),
    providerReports: [{ ...stamp, providerSpecific: { usage: finish.usage, metadata: finish.metadata } }]
  }, pricing)
}
