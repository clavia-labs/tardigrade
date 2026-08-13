import type { Envelope } from "@flamecast/core"
import { usageOf, type Usage } from "@flamecast/harness/infer"

// What a search reads off a stored log. Every function here is a pure projection over an
// array, so it runs against a recording with no runtime, no clock, and no model.
//
// There is no metric here on purpose. Blending quality against spend is a domain decision, and a
// blend this package shipped would be the wrong one everywhere.

// The turn's graded verdicts, in log order. The `reason` is the grader's sentence, and it is the
// feedback a reflective proposer actually reads: a scalar says a candidate got 0.62, and a reason
// names the mechanism that lost the points.
export interface Verdict {
  readonly score: number
  readonly reason: string
}

export const verdictsOf = (log: ReadonlyArray<Envelope>): ReadonlyArray<Verdict> =>
  log
    .filter((event) => event.type === "RewardGranted")
    .map((event) => ({
      score: typeof event.score === "number" ? event.score : 0,
      reason: event.reason === undefined ? "" : String(event.reason)
    }))

export const scoreOf = (log: ReadonlyArray<Envelope>): number =>
  verdictsOf(log).reduce((total, verdict) => total + verdict.score, 0)

// What a slice of the record spent on the model. `usageIn` in the harness answers this for one turn;
// this one answers it for whatever span you hand it, which is what a rollout needs when it reports
// the cost of the part it actually ran.
export const spendOf = (log: ReadonlyArray<Envelope>): Usage =>
  log
    .filter((event) => event.type === "ModelReturned")
    .map((event) => usageOf(event.usage))
    .reduce(
      (total, one) => ({
        promptTokens: total.promptTokens + one.promptTokens,
        completionTokens: total.completionTokens + one.completionTokens,
        costUsd: total.costUsd + one.costUsd
      }),
      { promptTokens: 0, completionTokens: 0, costUsd: 0 }
    )
