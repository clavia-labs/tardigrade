import type {} from "@tardie/ai-openrouter"
import type { ReportedCostReader } from "../usage"

// reportedCostOf reads provider monetary evidence without estimating token prices (openrouter.test.ts).
export const reportedCostOf: ReportedCostReader = (finish) => {
  const metadata = finish.metadata
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined
  const openrouter = (metadata as Record<string, unknown>).openrouter
  if (typeof openrouter !== "object" || openrouter === null || Array.isArray(openrouter)) return undefined
  const usage = (openrouter as Record<string, unknown>).usage
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return undefined
  const cost = (usage as Record<string, unknown>).cost
  return typeof cost === "number" ? cost : undefined
}
