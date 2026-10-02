import { Clock, Context, Effect, Layer } from "effect"
import * as fc from "fast-check"
import { defineActor, effectAtom, RuntimeError, type Journal, type Recorded, type StoredCheckpoint } from "@clavia/tardigrade-core"
import { createTestStore } from "./runtime/store"
import { trajectory, messages, timeSpend } from "@clavia/tardigrade-agent/atoms/durable"
import { Event } from "@clavia/tardigrade-agent/contracts/events"

// turnFactRecovery preserves message order, attribution, and receipt-to-settlement elapsed time across replay and checkpoints.
export const turnFactRecovery = fc.asyncProperty(fc.record({
  start: fc.integer({ min: 0, max: 1_000_000 }),
  first: fc.integer({ min: 0, max: 10_000 }), second: fc.integer({ min: 0, max: 10_000 }),
  checkpoint: fc.boolean(),
}), options => Effect.runPromise(Effect.gen(function* () {
  let now = options.start
  const base = yield* Clock.clockWith(Effect.succeed)
  const clock: Clock.Clock = { ...base, currentTimeMillisUnsafe: () => now, currentTimeMillis: Effect.sync(() => now) }
  const records: Recorded<Event>[] = []
  let checkpoint: StoredCheckpoint | undefined
  const journal: Journal<Event> = {
    read: Effect.sync(() => [...records]), readAfter: position => Effect.sync(() => records.slice(position)),
    readCheckpoint: Effect.sync(() => checkpoint),
    append: (position, events) => Effect.sync(() => {
      if (position !== records.length) throw new RuntimeError("Unexpected journal position")
      records.push(...events)
    }),
    appendWithCheckpoint: (position, events, value) => Effect.sync(() => {
      if (position !== records.length) throw new RuntimeError("Unexpected checkpoint position")
      records.push(...events)
      checkpoint = value
    }),
  }
  const actor = defineActor("turn-facts", Effect.sync(() => ({
    atom: effectAtom(get => ({
      view: { trajectory: get(trajectory), messages: get(messages), timeSpend: get(timeSpend) }, events: {}, acts: {},
    })), schema: Event
  })))
  const open = () => createTestStore({ actor, journal, checkpoint: { mode: "manual" }, actorContext: () => Context.empty(), services: () => Layer.empty })
  yield* Effect.gen(function* () {
    let store = yield* open()
    const model = { model: { provider: "openrouter" as const, model_id: "test" }, contextWindowTokens: 10_000 }
    yield* Effect.gen(function* () {
      yield* store.send([{ type: "TurnRequested", turnId: "first", text: "first" }])
      yield* store.send([{ type: "ModelCalled", purpose: "inference", callId: "m1", turnId: "first", ...model }])
      yield* store.send([{ type: "TurnRequested", turnId: "second", text: "second" }])
      if (options.checkpoint) yield* store.checkpoint
      const before = JSON.stringify(store.getState())
      yield* store.close
      now += options.first
      store = yield* open()
      if (JSON.stringify(store.getState()) !== before) return yield* Effect.fail(new RuntimeError("Restore changed turn facts without a new event"))
      yield* store.send([{ type: "ModelReturned", purpose: "inference", callId: "m1", text: "working", toolCalls: [{ callId: "tool", providerId: "provider", name: "job", input: {} }] }])
      yield* store.send([{ type: "ModelCalled", purpose: "inference", callId: "m2", turnId: "second", ...model }])
      yield* store.send([{ type: "ModelReturned", purpose: "inference", callId: "m2", text: "answer", toolCalls: [] }])
      yield* store.send([{ type: "ToolReturned", callId: "tool", output: "late", error: null }])
      yield* store.send([{ type: "TurnSettled", turnId: "first", outcome: "cancelled", reason: "stop" }])
      now += options.second
      yield* store.send([{ type: "TurnSettled", turnId: "second", outcome: "completed", callId: "m2" }])
      if (records.some(record => !Number.isSafeInteger(record.recordedAt) || "recordedAt" in record.event)) return yield* Effect.fail(new RuntimeError("Journal metadata leaked into the event payload"))
      const state = store.getState().view
      if (JSON.stringify(state.trajectory.map(entry => entry.turnId)) !== JSON.stringify(["first", "second", "first", "second", "first"])) return yield* Effect.fail(new RuntimeError("Trajectory lost arrival order or turn attribution"))
      if (JSON.stringify(state.messages) !== JSON.stringify(state.trajectory.map(entry => entry.message))) return yield* Effect.fail(new RuntimeError("Model messages diverged from trajectory"))
      if (JSON.stringify(state.timeSpend) !== JSON.stringify([{ turnId: "first", ms: options.first }, { turnId: "second", ms: options.first + options.second }])) return yield* Effect.fail(new RuntimeError("Turn timing omitted queue time or downtime"))
      if (options.checkpoint) yield* store.checkpoint
      const settled = JSON.stringify(store.getState())
      yield* store.close
      now += 100_000
      store = yield* open()
      if (JSON.stringify(store.getState()) !== settled) return yield* Effect.fail(new RuntimeError("Completed turn facts changed after reopening"))
      const completed = store.getState().view.timeSpend
      yield* store.send([{ type: "TurnRequested", turnId: "third", text: "third" }])
      now += options.first + options.second
      yield* store.send([{ type: "AbortRequested", reason: "stop", ref: { method: "turn", id: "third" } }])
      const pending = store.getState().view.timeSpend
      if (pending[0] !== completed[0] || pending[1] !== completed[1] || pending[2]?.ms !== options.first + options.second) return yield* Effect.fail(new RuntimeError("Pending timing changed completed totals or used a stale index"))
      yield* store.send([{ type: "TurnSettled", turnId: "third", outcome: "cancelled", reason: "stop" }])
    }).pipe(Effect.ensuring(Effect.suspend(() => store.close)))
  }).pipe(Effect.provideService(Clock.Clock, clock))
}).pipe(Effect.scoped)))
