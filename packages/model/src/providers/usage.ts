import type {} from "@tardie/ai-openrouter"
import type { ReportedCostReader } from "../usage"

// reportedCostOf reads provider monetary evidence without estimating token prices (openrouter.test.ts).
export const reportedCostOf: ReportedCostReader = (finish) => finish.metadata.openrouter?.usage?.cost ?? undefined
