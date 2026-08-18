import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import type { Envelope } from "@flamecast/core/envelope"
import { EventLog, withWatermark } from "@flamecast/core/event-log"
import { send, actor } from "@flamecast/core/actor"
import { Infer } from "./infer"
import { agentActorKeys } from "./turn"
import {
  COMPACTION_FIRE_TOKENS,
  COMPACTION_KEEP_TOKENS,
  checkpointOf,
  compactionReactor,
  estimateTokens,
  suffixOf
} from "./compaction"

// Compaction is a pure machine: a guard fires at a turn's end when the suffix passes FIRE tokens,
// the pass summarizes down to a KEEP-token tail, and the checkpoint binds. The summarizer is the
// ordinary Infer seam, stubbed here. The size measure is chars over four.

// A turn with a big tool result, sized so a few turns cross the token budget.
const bigTurn = (i: number): Envelope[] => [
  { type: "MessageReceived", id: `m${i}`, text: `question ${i}`, at: i * 3 },
  { type: "ToolReturned", callId: `c${i}`, result: { data: "x".repeat(20_000) }, turn: `m${i}`, at: i * 3 + 1 },
  { type: "ReplyDelivered", turn: `m${i}`, at: i * 3 + 2 }
]

describe("the compaction measure and guard", () => {
  test("estimateTokens is chars over four", () => {
    expect(estimateTokens([{ type: "X", pad: "y".repeat(396) } as Envelope])).toBeGreaterThan(100)
  })

  test("the guard fires on a turn end only when the suffix is over budget", () => {
    const small = bigTurn(0).slice(0, 1).concat([{ type: "ReplyDelivered", at: 9 }])
    expect(compactionReactor(small)).toHaveLength(0) // tiny suffix, no fire
    const big: Envelope[] = []
    for (let i = 0; i < 4; i++) big.push(...bigTurn(i)) // ~20k tokens, past the 16k FIRE
    expect(estimateTokens(suffixOf(big))).toBeGreaterThan(COMPACTION_FIRE_TOKENS)
    expect(compactionReactor(big)).toHaveLength(1) // a turn ended with the suffix over FIRE
  })

  test("the guard is pure: the fold runs with the clock and randomness rigged to throw", () => {
    const big: Envelope[] = []
    for (let i = 0; i < 4; i++) big.push(...bigTurn(i))
    const realNow = Date.now
    const realRandom = Math.random
    Date.now = () => {
      throw new Error("clock in the compaction guard")
    }
    Math.random = () => {
      throw new Error("random in the compaction guard")
    }
    try {
      expect(compactionReactor(big)).toHaveLength(1)
    } finally {
      Date.now = realNow
      Math.random = realRandom
    }
  })
})

const mailbox = actor<Infer | EventLog>([compactionReactor], agentActorKeys)

describe("the compaction pass", () => {
  test("a fire summarizes and checkpoints down to a KEEP-token tail", async () => {
    const initial: Envelope[] = []
    for (let i = 0; i < 6; i++) initial.push(...bigTurn(i)) // ~30k tokens of suffix
    const ref = Effect.runSync(Ref.make<ReadonlyArray<Envelope>>(initial))
    let briefed = ""
    const layers = Layer.mergeAll(
      Layer.succeed(EventLog, withWatermark({
        append: (events: ReadonlyArray<Envelope>) => Ref.update(ref, (log) => [...log, ...events]),
        read: Ref.get(ref)
      })),
      Layer.succeed(Infer, {
        react: (trajectory: ReadonlyArray<Envelope>) => {
          briefed = String((trajectory[0] as { text?: unknown }).text ?? "")
          return Effect.succeed({ kind: "complete" as const, output: "the user asked 0..N and got answers" })
        }
      })
    )
    await Effect.runPromise(
      send(mailbox, { type: "CompactionFired", at: 999 }).pipe(Effect.provide(layers)) as Effect.Effect<void>
    )
    const log = await Effect.runPromise(Ref.get(ref))
    const checkpoint = checkpointOf(log)
    expect(checkpoint.summary).toBe("the user asked 0..N and got answers")
    // The retained tail fits the KEEP budget (allow one event of slack for the boundary event).
    const tailBudget = COMPACTION_KEEP_TOKENS + estimateTokens([log[log.length - 1]!])
    expect(estimateTokens(suffixOf(log))).toBeLessThanOrEqual(tailBudget)
    expect(briefed).toContain("question 0")
  })
})
