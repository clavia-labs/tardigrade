import type { Response } from "effect/ai"

export type ReportedCostReader = (finish: Response.FinishPart) => number | undefined
