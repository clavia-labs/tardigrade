import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import type { Event } from "@tardigrade/core/event"
import { EventLog, withWatermark } from "@tardigrade/core/event-log"
import { send, actor } from "@tardigrade/core/actor"
import { Infer } from "./infer"
import { composeKeys } from "@tardigrade/core/event-log"
import { messageKeys } from "@tardigrade/core/message"
import { agentKeys } from "./events"

const agentActorKeys = composeKeys(messageKeys, agentKeys)
import {
  DEFAULT_CONTEXT_POLICY,
  checkpointOf,
  compactionReactor,
  compactionReactorFor,
  estimateTokens,
  keepFromIndex,
  suffixOf
} from "./compaction"

// Compaction is a pure machine: a guard fires at a resolved tool round when the rendered suffix
// passes FIRE tokens, the pass summarizes down to a KEEP-token tail, and the checkpoint binds by
// event identity. The summarizer is the ordinary Infer seam, stubbed here. The size measure is
// rendered chars over four.

const head: Event = { type: "MessageReceived", id: "m0", text: "extract the covenants", at: 0 }

// One resolved tool round inside the open turn, sized so a dozen rounds cross the token budget.
const round = (i: number, turn = "m0"): Event[] => [
  { type: "ToolCalled", callId: `c${i}`, name: "execute", arguments: { code: `run ${i}` }, turn, at: i * 2 + 1 },
  { type: "ToolReturned", callId: `c${i}`, result: { data: "x".repeat(5_000) }, turn, at: i * 2 + 2 }
]

const openTurn = (rounds: number): Event[] => {
  const log: Event[] = [head]
  for (let i = 1; i <= rounds; i++) log.push(...round(i))
  return log
}

describe("the compaction measure and guard", () => {
  test("the measure counts what a render sends: capped results, skipped lanes", () => {
    const big: Event = { type: "ToolReturned", callId: "c", result: { data: "x".repeat(40_000) }, at: 1 }
    expect(estimateTokens([big])).toBe(Math.ceil(DEFAULT_CONTEXT_POLICY.resultRenderCap / 4))
    const lane: Event = { type: "CodeSettled", execId: "c", result: 1, at: 2 } as Event
    expect(estimateTokens([lane])).toBe(0)
  })

  test("the guard fires inside an open turn once a resolved round passes FIRE", () => {
    expect(estimateTokens(suffixOf(openTurn(16)))).toBeGreaterThan(DEFAULT_CONTEXT_POLICY.fireTokens)
    expect(compactionReactor(openTurn(16))).toHaveLength(1) // no reply anywhere, the turn is live
    expect(compactionReactor(openTurn(2))).toHaveLength(0) // under FIRE
  })

  test("the guard holds while a call is unanswered", () => {
    const awaiting: Event[] = [
      ...openTurn(16),
      { type: "ToolCalled", callId: "c99", name: "execute", arguments: {}, turn: "m0", at: 99 }
    ]
    expect(compactionReactor(awaiting)).toHaveLength(0)
  })

  test("the policy is the consumer's: a raised FIRE holds the guard, a lowered one fires early", () => {
    expect(compactionReactorFor({ fireTokens: 1_000_000 })(openTurn(16))).toHaveLength(0)
    expect(compactionReactorFor({ fireTokens: 100 })(openTurn(2))).toHaveLength(1)
    // The measure moves with the render cap, because one policy states both.
    const big: Event = { type: "ToolReturned", callId: "c", result: { data: "x".repeat(40_000) }, at: 1 }
    expect(estimateTokens([big], { resultRenderCap: 40 })).toBe(10)
  })

  test("the guard is pure: the fold runs with the clock and randomness rigged to throw", () => {
    const realNow = Date.now
    const realRandom = Math.random
    Date.now = () => {
      throw new Error("clock in the compaction guard")
    }
    Math.random = () => {
      throw new Error("random in the compaction guard")
    }
    try {
      expect(compactionReactor(openTurn(16))).toHaveLength(1)
    } finally {
      Date.now = realNow
      Math.random = realRandom
    }
  })
})

const mailbox = actor<Infer | EventLog>([compactionReactor], agentActorKeys)

describe("the compaction pass", () => {
  const run = async (initial: ReadonlyArray<Event>) => {
    const ref = Effect.runSync(Ref.make<ReadonlyArray<Event>>(initial))
    let briefed = ""
    const layers = Layer.mergeAll(
      Layer.succeed(
        EventLog,
        withWatermark({
          append: (events: ReadonlyArray<Event>) => Ref.update(ref, (log) => [...log, ...events]),
          read: Ref.get(ref)
        })
      ),
      Layer.succeed(Infer, {
        react: ({ trajectory }: { trajectory: ReadonlyArray<Event> }) => {
          briefed = String((trajectory[0] as { text?: unknown }).text ?? "")
          return Effect.succeed({ kind: "complete" as const, output: "covenants 1 through 13 extracted" })
        }
      })
    )
    await Effect.runPromise(
      send(mailbox, { type: "CompactionFired", at: 999 }).pipe(Effect.provide(layers)) as Effect.Effect<void>
    )
    return { log: await Effect.runPromise(Ref.get(ref)), briefed: () => briefed }
  }

  test("a fire summarizes and checkpoints down to a KEEP-token tail, mid-turn", async () => {
    const { log, briefed } = await run(openTurn(16))
    const checkpoint = checkpointOf(log)
    expect(checkpoint.summary).toBe("covenants 1 through 13 extracted")
    expect(keepFromIndex(log, checkpoint.keepFrom)).toBeGreaterThan(0)
    // The retained tail fits KEEP plus at most one round of boundary slack.
    const roundTokens = estimateTokens(round(1))
    expect(estimateTokens(suffixOf(log))).toBeLessThanOrEqual(DEFAULT_CONTEXT_POLICY.keepTokens + 2 * roundTokens)
    expect(briefed()).toContain("extract the covenants")
    expect(briefed()).toContain("run 1")
  })

  test("the cut lands on a boundary: a kept tail opens with a call, its return beside it", async () => {
    const { log } = await run(openTurn(16))
    const suffix = suffixOf(log)
    expect(suffix[0]!.type).toBe("ToolCalled")
    const callId = String((suffix[0] as { callId?: unknown }).callId)
    expect(checkpointOf(log).keepFrom).toBe(`c:${callId}`)
    expect(suffix.some((e) => e.type === "ToolReturned" && String((e as { callId?: unknown }).callId) === callId)).toBe(
      true
    )
  })

  test("a second crossing keys anew and reaches further", async () => {
    const first = await run(openTurn(16))
    const grown: Event[] = [...first.log]
    for (let i = 17; i <= 32; i++) grown.push(...round(i))
    const second = await run(grown)
    const checkpoint = checkpointOf(second.log)
    expect(keepFromIndex(second.log, checkpoint.keepFrom)).toBeGreaterThan(
      keepFromIndex(first.log, checkpointOf(first.log).keepFrom)
    )
  })
})
