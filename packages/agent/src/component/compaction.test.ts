import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import { actorFromProjections, Self, send } from "@clavia/tardigrade-core/runtime"
import { completeTransitionProjection } from "@clavia/tardigrade-core/transition"
import { Infer } from "../inference/contract"
import { composeKeys } from "@clavia/tardigrade-core/log"
import { messageKeys } from "@clavia/tardigrade-core/communication/message"
import { agentKeys } from "../log/events"

const agentActorKeys = composeKeys(messageKeys, agentKeys)
import {
  checkpointOf,
  compaction,
  compactionReactor,
  contextPolicyOf,
  estimateTokens,
  keepFromIndex,
  suffixOf,
  type CompactionPolicy
} from "./compaction"

// Compaction is a pure machine: a guard fires at a resolved tool round when the rendered suffix
// passes FIRE tokens, the pass summarizes down to a KEEP-token tail, and the checkpoint binds by
// event identity. The summarizer is the ordinary Infer seam, stubbed here. The size measure is
// rendered chars over four.

const head: Event = { type: "MessageReceived", id: "m0", text: "extract the covenants", at: 0 }
const TEST_POLICY = { contextWindowTokens: 20_000, fireRatio: 0.8, keepRatio: 0.2 }
const TEST_CONTEXT = contextPolicyOf(TEST_POLICY)
const reactor = compactionReactor(TEST_POLICY)

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
  test("the incremental quotient agrees with complete replay at every prefix", () => {
    const component = compaction(TEST_POLICY)
    const projection = component.machine
    let state = projection.initial()
    const log: Event[] = []
    for (const event of openTurn(16)) {
      log.push(event)
      state = projection.step(state, event)
      expect(projection.output(state).transitions.map((transition) => transition.key))
        .toEqual(reactor(log).map((transition) => transition.key))
    }
  })

  test("the measure counts what a render sends: capped results, skipped threads", () => {
    const big: Event = { type: "ToolReturned", callId: "c", result: { data: "x".repeat(40_000) }, at: 1 }
    expect(estimateTokens([big])).toBe(Math.ceil(TEST_CONTEXT.resultRenderCap / 4))
    const thread: Event = { type: "CodeSettled", execId: "c", result: 1, at: 2 } as Event
    expect(estimateTokens([thread])).toBe(0)
  })

  test("the guard fires inside an open turn once a resolved round passes FIRE", () => {
    expect(estimateTokens(suffixOf(openTurn(16)))).toBeGreaterThan(TEST_CONTEXT.fireTokens)
    expect(reactor(openTurn(16))).toHaveLength(1) // no reply anywhere, the turn is live
    expect(reactor(openTurn(2))).toHaveLength(0) // under FIRE
  })

  test("the guard holds while a call is unanswered", () => {
    const awaiting: Event[] = [
      ...openTurn(16),
      { type: "ToolCalled", callId: "c99", name: "execute", arguments: {}, turn: "m0", at: 99 }
    ]
    expect(reactor(awaiting)).toHaveLength(0)
  })

  test("the policy is the consumer's: a raised FIRE holds the guard, a lowered one fires early", () => {
    expect(compactionReactor({ contextWindowTokens: 1_250_000 })(openTurn(16))).toHaveLength(0)
    expect(compactionReactor({ contextWindowTokens: 125 })(openTurn(2))).toHaveLength(1)
    // The measure moves with the render cap, because one policy states both.
    const big: Event = { type: "ToolReturned", callId: "c", result: { data: "x".repeat(40_000) }, at: 1 }
    expect(estimateTokens([big], { resultRenderCap: 40 })).toBe(10)
  })

  test("the selected model resolves both hysteresis lines from one window", () => {
    const policy = contextPolicyOf(
      { contextWindowTokens: (model) => model?.model_id === "large" ? 1_000_000 : 100_000 },
      { provider: "test", model_id: "large" }
    )
    expect(policy.fireTokens).toBe(800_000)
    expect(policy.keepTokens).toBe(500_000)
  })

  test("the keep line must remain below the fire line", () => {
    expect(() => contextPolicyOf({ keepRatio: 0.9, fireRatio: 0.8 })).toThrow("keepRatio must be less than fireRatio")
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
      expect(reactor(openTurn(16))).toHaveLength(1)
    } finally {
      Date.now = realNow
      Math.random = realRandom
    }
  })
})

describe("the compaction pass", () => {
  const run = async (initial: ReadonlyArray<Event>, policy: Partial<CompactionPolicy> = TEST_POLICY) => {
    const ref = Ref.makeUnsafe<ReadonlyArray<Event>>(initial)
    let briefed = ""
    let model: unknown
    const actor = actorFromProjections<Infer | EventLog | Self>({
      transitions: [completeTransitionProjection(compactionReactor(policy))],
      keyOf: agentActorKeys
    })
    const layers = Layer.mergeAll(
      Layer.succeed(
        EventLog,
        withWatermark({
          append: (events: ReadonlyArray<Event>) => Ref.update(ref, (log) => [...log, ...events]),
          read: Ref.get(ref)
        })
      ),
      Layer.succeed(Infer, {
        react: ({ trajectory, model: selected }: { trajectory: ReadonlyArray<Event>; model?: unknown }) => {
          briefed = String((trajectory[0] as { text?: unknown }).text ?? "")
          model = selected
          return Effect.succeed({ kind: "complete" as const, output: "covenants 1 through 13 extracted" })
        }
      }),
      Layer.succeed(Self, { actor: "test", instance: "main", thread: "compaction" })
    )
    await Effect.runPromise(
      send(actor, { type: "CompactionFired", at: 999 }).pipe(Effect.provide(layers)) as Effect.Effect<void>
    )
    return { log: await Effect.runPromise(Ref.get(ref)), briefed: () => briefed, model: () => model }
  }

  test("a fire summarizes and checkpoints down to a KEEP-token tail, mid-turn", async () => {
    const { log, briefed } = await run(openTurn(16))
    const checkpoint = checkpointOf(log)
    expect(log.find((event) => event.type === "CompactionCompleted")).toMatchObject({
      contextWindowTokens: 20_000,
      fireTokens: 16_000,
      keepTokens: 4_000
    })
    expect(checkpoint.summary).toBe("covenants 1 through 13 extracted")
    expect(keepFromIndex(log, checkpoint.keepFrom)).toBeGreaterThan(0)
    // The retained tail fits KEEP plus at most one round of boundary slack.
    const roundTokens = estimateTokens(round(1))
    expect(estimateTokens(suffixOf(log))).toBeLessThanOrEqual(TEST_CONTEXT.keepTokens + 2 * roundTokens)
    expect(briefed()).toContain("extract the covenants")
    expect(briefed()).toContain("run 1")
  })

  test("a pass can select its model", async () => {
    const selected = { provider: "test", model_id: "compact" } as const
    const { log, model } = await run(openTurn(16), { ...TEST_POLICY, model: selected })
    expect(model()).toEqual(selected)
    expect(log.find((event) => event.type === "CompactionCompleted")).toMatchObject({ model: selected })
  })

  test("the cut lands on a boundary: a kept tail opens with a call, its return beside it", async () => {
    const { log } = await run(openTurn(16))
    const suffix = suffixOf(log)
    expect(suffix[0]!.type).toBe("ToolCalled")
    const callId = String((suffix[0] as { callId?: unknown }).callId)
    expect(checkpointOf(log).keepFrom).toBe(`c:${JSON.stringify(["m0", callId])}`)
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

// One projection serves the render, the measure, and the brief. A corrected exchange the model
// no longer reads must not weigh on the guard that spends money, and must not leak its rejected
// reply into a summary a later turn does read (src/projection/transcript.ts, projectedOutput).
describe("a projected repair is invisible to compaction as well as to the render", () => {
  const REPAIR = { kind: "repair", name: "repair", attempts: 2, projectHistory: true }
  const rejected = (turn: string, at: number, implementation: unknown = REPAIR): Event => ({
    type: "OutputRejected",
    contract: "scout",
    attempt: `${turn}/infer/0`,
    text: "x".repeat(4_000),
    errors: ["/a: expected string"],
    mode: implementation,
    turn,
    at
  })

  test("the measure counts an owed correction and drops a corrected one", () => {
    const owed: ReadonlyArray<Event> = [rejected("m1", 1)]
    expect(estimateTokens(owed)).toBeGreaterThan(900)
    const corrected: ReadonlyArray<Event> = [rejected("m1", 1), { type: "TurnCompleted", output: "{}", turn: "m1", at: 2 }]
    expect(estimateTokens(corrected)).toBeLessThan(10)
    // A policy that keeps history keeps its weight too.
    const kept: ReadonlyArray<Event> = [
      rejected("m1", 1, { kind: "repair", name: "repair", attempts: 2, projectHistory: false }),
      { type: "TurnCompleted", output: "{}", turn: "m1", at: 2 }
    ]
    expect(estimateTokens(kept)).toBeGreaterThan(900)
  })

  test("the incremental quotient agrees while a completion hides its correction exchange", () => {
    const policy = { contextWindowTokens: 125 }
    const complete = compactionReactor(policy)
    const component = compaction(policy)
    const projection = component.machine
    const events: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m1", text: "go", at: 0 },
      rejected("m1", 1),
      { type: "OutputRetryRequested", rejection: "m1/infer/0", feedback: "again", turn: "m1", at: 2 } as Event,
      { type: "TurnCompleted", output: "{}", turn: "m1", at: 3 }
    ]
    const log: Event[] = []
    let state = projection.initial()
    for (const event of events) {
      log.push(event)
      state = projection.step(state, event)
      expect(projection.output(state).transitions.map((transition) => ({
        key: transition.key,
        input: transition.input
      }))).toEqual(complete(log).map((transition) => ({
        key: transition.key,
        input: transition.input
      })))
    }
  })

  test("the summary brief never carries a corrected reply, and the log still does", async () => {
    const briefs: string[] = []
    const log: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m1", text: "go", at: 0 },
      { type: "ToolCalled", callId: "c1", name: "execute", arguments: { code: "x".repeat(80_000) }, turn: "m1", at: 1 },
      { type: "ToolReturned", callId: "c1", result: "ok", turn: "m1", at: 2 },
      rejected("m1", 3),
      { type: "TurnCompleted", output: "{}", turn: "m1", at: 4 },
      { type: "MessageReceived", id: "m2", text: "next", at: 5 },
      { type: "ToolCalled", callId: "c2", name: "execute", arguments: { code: "return 2" }, turn: "m2", at: 6 },
      { type: "ToolReturned", callId: "c2", result: "ok", turn: "m2", at: 7 }
    ]
    const events = await Effect.runPromise(
      Effect.all(reactor(log).map((transition) => {
        if (transition.kind !== "effect") throw new Error("compaction must be an effect")
        return transition.act(transition.input as never, new AbortController().signal)
      })).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(Infer, {
              react: ({ trajectory }: { trajectory: ReadonlyArray<Event> }) => {
                briefs.push(String((trajectory[0] as { text?: unknown }).text))
                return Effect.succeed({ kind: "complete" as const, output: "summarized" })
              }
            }),
            Layer.succeed(Self, { actor: "test", instance: "main", thread: "compaction" })
          )
        )
      ) as unknown as Effect.Effect<ReadonlyArray<ReadonlyArray<Event>>>
    )
    expect(events.flat().some((e) => e.type === "CompactionCompleted")).toBe(true)
    expect(briefs).toHaveLength(1)
    expect(briefs[0]).not.toContain("agent (refused")
    expect(briefs[0]).not.toContain("xxxx")
    // The rejection is still a fact of the log; only every reader of the projection dropped it.
    expect(log.some((e) => e.type === "OutputRejected")).toBe(true)
  })
})
