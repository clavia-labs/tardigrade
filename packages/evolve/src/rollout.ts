import { Effect } from "effect"
import type { Event } from "@flamecast/core"
import { canonicalValue, type Agent, type AgentServices, type Usage } from "@flamecast/harness"
import { spendOf } from "./score"

export interface RolloutOptions<Baseline, Candidate> {
  readonly baseline: Agent<Baseline>
  readonly candidate: Agent<Candidate>
  readonly log: ReadonlyArray<Event>
}

export interface RolloutResult {
  readonly replayed: number
  readonly called: number
  readonly usage: Usage
  readonly log: ReadonlyArray<Event>
}

export interface Divergence {
  readonly replayed: number
  readonly upTo: number
}

const marksOf = (log: ReadonlyArray<Event>): ReadonlyArray<number> =>
  log.flatMap((event, index) => (event.type === "ModelCalled" ? [index] : []))

export const divergence = <Recorded, Candidate>(
  recorded: Agent<Recorded>,
  candidate: Agent<Candidate>,
  log: ReadonlyArray<Event>
): Divergence => {
  let replayed = 0
  for (const at of marksOf(log)) {
    const prefix = log.slice(0, at)
    if (canonicalValue(candidate.request(prefix)) !== canonicalValue(recorded.request(prefix))) {
      return { replayed, upTo: at }
    }
    replayed += 1
  }
  return { replayed, upTo: log.length }
}

export const rollout = <Baseline, Candidate>(
  options: RolloutOptions<Baseline, Candidate>
): Effect.Effect<
  RolloutResult,
  never,
  Baseline | Candidate | AgentServices
> =>
  Effect.suspend(() => {
    const { baseline, candidate, log } = options
    const head = log.find((event) => event.type === "MessageReceived")
    const provenance = head?.program === undefined || head.program === baseline.program.id
    const aligned = provenance
      ? divergence(baseline, candidate, log)
      : { replayed: 0, upTo: marksOf(log)[0] ?? log.length }
    const branch = candidate.branch(log.slice(0, aligned.upTo), {
      id: `rollout:${candidate.program.id}:${aligned.upTo}`
    })
    return Effect.gen(function* () {
      const seeded = (yield* branch.log).length
      yield* branch.replay([])
      const settled = yield* branch.log
      const tail = settled.slice(seeded)
      return {
        replayed: aligned.replayed,
        called: tail.filter((event) => event.type === "ModelCalled").length,
        usage: spendOf(tail),
        log: settled
      }
    })
  })
