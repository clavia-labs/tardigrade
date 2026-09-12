import type { Response } from "effect/unstable/ai"

export type ReportedCostReader = (finish: Response.FinishPart) => number | undefined
