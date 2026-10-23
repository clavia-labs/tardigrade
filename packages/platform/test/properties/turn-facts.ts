import { strict as assert } from "node:assert"
import { memoryJournalReads } from "../fixtures/memory-journal"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import * as fc from "fast-check"
import { createEventLog, StateInitialised, defineActor, effectAtom, RuntimeError, type Journal, type Recorded, type StoredCheckpoint } from "@clavia/tardigrade-core"
import { createTestStore } from "./runtime/store"
import { trajectory, messages, timeSpend } from "@clavia/tardigrade-agent/atoms/durable"
import { compact } from "@clavia/tardigrade-agent/atoms/compact"
import { ModelInfo } from "@clavia/tardigrade-agent/actor/context"
import { Generate } from "@clavia/tardigrade-agent/contracts/acts"
import { Event } from "@clavia/tardigrade-agent/contracts/events"

// turnFactRecovery preserves message order, attribution, and receipt-to-settlement elapsed time across replay and checkpoints.
export const turnFactRecovery = fc.asyncProperty(fc.record({
  start: fc.integer({ min: 0, max: 1_000_000 }),
  first: fc.integer({ min: 0, max: 10_000 }), second: fc.integer({ min: 0, max: 10_000 }),
  checkpoint: fc.boolean(),
}), options => Effect.runPromise(Effect.gen(function* () {
  let now = options.start
  const base = yield* Clock.clockWith(Effect.succeed)
  const clock: Clock.Clock = { ...base, currentTimeMillisUnsafe: () => now, currentTimeMillis: Effect.sync(() => now), currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n, currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n) }
  const records: Recorded<Event>[] = []
  let checkpoint: StoredCheckpoint | undefined
  const journal: Journal<Event> = {
    ...memoryJournalReads(() => records),
    readCheckpoint: () => checkpoint,
    append: (position, events) => {
      if (position !== records.length) throw new RuntimeError("Unexpected journal position")
      records.push(...events)
    },
    appendWithCheckpoint: (position, events, value) => {
      if (position !== records.length) throw new RuntimeError("Unexpected checkpoint position")
      if (value.position !== (checkpoint?.position ?? 0) + 2) throw new RuntimeError("Checkpoint threshold cadence changed across recovery")
      records.push(...events)
      checkpoint = value
    },
  }
  const actor = defineActor("turn-facts", Effect.sync(() => ({
    atom: effectAtom(get => ({
      view: { trajectory: get(trajectory.range({ limit: 100 })).rows.map(row => row.value), messages: get(messages.range({ limit: 100 })).rows.map(row => row.value), timeSpend: get(timeSpend) }, events: {}, acts: {},
    })), schema: Event
  })))
  const open = () => createTestStore({ actor, journal, checkpoint: options.checkpoint ? { mode: "threshold", options: { everyEvents: 2 } } : { mode: "manual" }, actorContext: () => Context.empty(), services: () => Layer.empty })
  yield* Effect.gen(function* () {
    let store = yield* open()
    const model = { model: { provider: "openrouter" as const, model_id: "test" }, contextWindowTokens: 10_000 }
    yield* Effect.gen(function* () {
      yield* store.send([{ type: "TurnRequested", turnId: "first", text: "first" }])
      yield* store.send([{ type: "ModelCalled", purpose: "inference", callId: "m1", turnId: "first", ...model }])
      yield* store.send([{ type: "TurnRequested", turnId: "second", text: "second" }])
      if (options.checkpoint && checkpoint?.position !== records.length - 1) return yield* Effect.fail(new RuntimeError("Threshold checkpoint omitted the recovery suffix"))
      const before = JSON.stringify(store.getState())
      yield* store.close
      now += options.first
      store = yield* open()
      if (JSON.stringify(store.getState()) !== before) return yield* Effect.fail(new RuntimeError("Restore changed turn facts without a new event"))
      yield* store.send([{ type: "ModelReturned", purpose: "inference", callId: "m1", text: "working", toolCalls: [{ callId: "tool", providerId: "provider", name: "job", input: {} }] }])
      yield* store.send([{ type: "ModelCalled", purpose: "inference", callId: "m2", turnId: "second", ...model }])
      yield* store.send([{ type: "ModelReturned", purpose: "inference", callId: "m2", text: "answer", toolCalls: [] }])
      yield* store.send([{ type: "ToolReturned", version: 1, callId: "tool", content: [{ type: "text", text: "late" }], error: null }])
      yield* store.send([{ type: "TurnSettled", turnId: "first", outcome: "cancelled", reason: "stop" }])
      now += options.second
      yield* store.send([{ type: "TurnSettled", turnId: "second", outcome: "completed", callId: "m2" }])
      if (records.some(record => !Number.isSafeInteger(record.recordedAt) || "recordedAt" in record.event)) return yield* Effect.fail(new RuntimeError("Journal metadata leaked into the event payload"))
      const state = store.getState().view
      if (JSON.stringify(state.trajectory.map(entry => entry.turnId)) !== JSON.stringify(["first", "second", "first", "second", "first"])) return yield* Effect.fail(new RuntimeError("Trajectory lost arrival order or turn attribution"))
      if (JSON.stringify(state.messages) !== JSON.stringify(state.trajectory.map(entry => entry.message))) return yield* Effect.fail(new RuntimeError("Model messages diverged from trajectory"))
      if (JSON.stringify(state.timeSpend) !== JSON.stringify([{ turnId: "first", ms: options.first }, { turnId: "second", ms: options.first + options.second }])) return yield* Effect.fail(new RuntimeError("Turn timing omitted queue time or downtime"))
      if (options.checkpoint && checkpoint?.position !== records.length - 1) return yield* Effect.fail(new RuntimeError("Threshold checkpoint omitted the recovery suffix"))
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

// trajectoryCompaction bounds each loaded window, preserves complete tool exchanges, and resumes from journal cursors after recovery.
export const trajectoryCompaction = fc.property(fc.integer({ min: 4, max: 20 }), fc.boolean(), (count, legacy) => {
  const selection = { model: { provider: "test", model_id: "test" }, contextWindowTokens: 4_096 }
  const records: Recorded<Event>[] = [{ event: { type: "ModelConfigured", ...selection } }]
  for (let index = 0; index < count; index++) {
    const turnId = `turn:${index}`
    const callId = `model:${index}`
    const toolId = `tool:${index}`
    records.push(
      { event: { type: "TurnRequested", turnId, text: `question:${index}` } },
      { event: { type: "ModelCalled", purpose: "inference", turnId, callId, ...selection } },
      { event: { type: "ModelReturned", purpose: "inference", ...(legacy ? {} : { turnId }), callId, text: "working", toolCalls: [{ callId: toolId, providerId: toolId, name: "job", input: {} }] } },
      { event: { type: "ToolReturned", version: 1, ...(legacy ? {} : { turnId, tool: { name: "job", providerId: toolId } }), callId: toolId, content: [{ type: "text", text: "result" }], error: null } },
      { event: { type: "TurnSettled", turnId, outcome: "failed", reason: "fixture" } },
    )
  }
  if (legacy) records.push(
    { event: { type: "ModelCalled", purpose: "compaction", callId: "legacy", through: 3, ...selection } },
    { event: { type: "ModelReturned", purpose: "compaction", callId: "legacy", text: "Earlier summary" } },
  )
  const context = Effect.runSync(compact(messages, { pageSize: 2, maxContextMessages: 8 }).pipe(Effect.provideService(ModelInfo, selection)))
  const log = createEventLog({ schema: Event, atoms: { context } })
  try {
    let snapshot = log.replay(records)
    let compactions = 0
    for (let step = 0; step <= count; step++) {
      const output = snapshot.view().context
      if (output.view.position === "ready") {
        assert.ok(output.view.messages.length <= 9)
        assert.ok(output.view.messages.some(message => message.role === "tool" && message.callId === `tool:${count - 1}`))
        break
      }
      assert.equal(output.view.position, "compacting")
      const proposal = output.acts.compact
      assert.ok(proposal)
      const input = proposal.request.input as { readonly context: readonly { readonly text: string }[] }
      const body = input.context[0]!.text
      const chunk = JSON.parse(body.slice(body.indexOf("\n") + 1)) as Array<{ role: string; toolCalls?: Array<{ callId: string }>; callId?: string }>
      assert.ok(chunk.length <= 9)
      const pending = new Set<string>()
      for (const message of chunk) {
        if (message.role === "assistant") for (const call of message.toolCalls ?? []) pending.add(call.callId)
        if (message.role === "tool") { assert.ok(pending.has(message.callId!)); pending.delete(message.callId!) }
      }
      assert.equal(pending.size, 0)
      const ref = { seq: snapshot.position, atom: "context", act: "compact" }
      const called = Schema.decodeUnknownSync(Schema.toType(Event))(proposal.onRequested!(ref)[0]!)
      assert.ok("cursor" in called && typeof called.cursor === "number")
      snapshot = log.append(snapshot, called)
      const settled = proposal.onSettled!({ status: "fulfilled", value: { text: "Summary", toolCalls: [] } }, ref)
      snapshot = log.append(snapshot, Schema.decodeUnknownSync(Schema.toType(Event))(settled[0]!))
      compactions++
    }
    assert.ok(compactions > 0)
    assert.equal(snapshot.view().context.view.position, "ready")
    const checkpoint = snapshot.checkpoint()!
    assert.ok(checkpoint.durable.every(entry => entry.name !== "agent.trajectory" && !entry.name.includes("agent.trajectory.model-turn")))
    const state = checkpoint.durable.find(entry => entry.name === "agent.compaction.state")!.state as { cursor: number }
    assert.ok(state.cursor > 0)
    const history = snapshot.records.slice()
    let earliest = Infinity
    const restored = createEventLog({ schema: Event, atoms: { context }, checkpoint,
      readRange: (from, to) => history.slice(from, to), readOperation: () => [],
      readFamily: function* (family, key, from, to, order = "asc") {
        earliest = Math.min(earliest, from)
        for (let index = from; index < to; index++) {
          const position = order === "asc" ? index : to - (index - from) - 1
          if (family.key(history[position]!, position) === key) yield { position, record: history[position]! }
        }
      },
    })
    try {
      assert.deepEqual(restored.initial.view(), snapshot.view())
      if (!legacy) assert.ok(earliest >= state.cursor)
    } finally { restored.dispose() }
  } finally { log.dispose() }
})

// trajectoryWindowCache compares cached windows with fresh reads across publication, compaction, and forks while checking incremental query bounds.
export const trajectoryWindowCache = () => {
  const selection = { model: { provider: "test", model_id: "test" }, contextWindowTokens: 1_000_000 }
  const options = { pageSize: 2, maxContextMessages: 8 }
  const queries: Array<{ readonly from?: number; readonly to?: number }> = []
  const source = { ...messages, range: (query: Parameters<typeof messages.range>[0]) => { queries.push(query ?? {}); return messages.range(query) } }
  const make = (trajectory: Parameters<typeof compact>[0]) => Effect.runSync(compact(trajectory, options).pipe(Effect.provideService(ModelInfo, selection)))
  const context = make(source)
  const log = createEventLog({ schema: Event, atoms: { context } })
  const oracle = createEventLog({ schema: Event, atoms: { context: make({ range: messages.range }) } })
  try {
    const records: Recorded<Event>[] = [{ event: { type: "ModelConfigured", ...selection } }]
    for (let index = 0; index < 3; index++) records.push(
      { event: { type: "TurnRequested", turnId: String(index), text: `question:${index}` } },
      { event: { type: "ModelCalled", purpose: "inference", turnId: String(index), callId: String(index), ...selection } },
      { event: { type: "ModelReturned", purpose: "inference", turnId: String(index), callId: String(index), text: `answer:${index}`, toolCalls: [] } },
      { event: { type: "TurnSettled", turnId: String(index), outcome: "completed", callId: String(index) } },
    )
    let snapshot = log.replay(records)
    snapshot.get(context)
    const compare = () => {
      const view = snapshot.view().context.view
      assert.deepEqual(view, oracle.replay(snapshot.records).view().context.view)
      if (view.position === "ready") {
        const request = () => Generate.request({ input: { model: selection.model, system: "", tools: [], context: [...view.messages] } }).request.input as { readonly context: readonly unknown[] }
        const first = request(), second = request()
        for (const [index, message] of view.messages.entries()) {
          assert.equal(first.context[index], message)
          assert.equal(second.context[index], message)
        }
      }
    }
    const append = (event: Event) => {
      const position = snapshot.position
      queries.length = 0
      snapshot = log.publish(log.prepare(snapshot, event))
      compare()
      assert.ok(queries.filter(query => query.to !== 0).every(query => (query.from ?? 0) >= position))
    }
    compare()
    append({ type: "PermissionConfigured", policy: { default: "allow", actions: {} } })
    append({ type: "TurnRequested", turnId: "tail", text: "tail" })
    append({ type: "ModelCalled", purpose: "inference", turnId: "tail", callId: "tail", ...selection })
    append({ type: "ModelReturned", purpose: "inference", turnId: "tail", callId: "tail", text: "tail answer", toolCalls: [] })
    const fork = snapshot
    append({ type: "TurnRequested", turnId: "later", text: "later" })
    const proposal = snapshot.view().context.acts.compact!
    const ref = { seq: snapshot.position, atom: "context", act: "compact" }
    snapshot = log.append(snapshot, Schema.decodeUnknownSync(Schema.toType(Event))(proposal.onRequested!(ref)[0]!))
    snapshot = log.append(snapshot, Schema.decodeUnknownSync(Schema.toType(Event))(proposal.onSettled!({ status: "fulfilled", value: { text: "Summary", toolCalls: [] } }, ref)[0]!))
    compare()
    const view = snapshot.view().context.view
    assert.ok(view.position === "ready" && view.messages.length <= options.maxContextMessages + 1)
    snapshot = log.append(fork, { type: "TurnRequested", turnId: "branch", text: "different branch" })
    compare()
    assert.deepEqual(fork.view().context.view, oracle.replay(fork.records).view().context.view)
  } finally { log.dispose(); oracle.dispose() }
}

// trajectorySeedBoundary rejects metadata-only conversation cloning instead of returning an incomplete trajectory.
export const trajectorySeedBoundary = () => {
  const log = createEventLog({ schema: Event, atoms: { page: trajectory.range() } })
  try {
    for (const initialState of [
      { "agent.trajectory": { entries: [], models: [] } },
      { "agent.inference.state": { turns: [{ turnId: "old" }] } },
      { "agent.inference.active": { turns: [{ turnId: "old" }] } },
      { "agent.compaction.state": { through: 0, summary: "", origin: 5 } },
      { "agent.compaction.state": { through: 2, summary: "Earlier" } },
    ]) assert.throws(() => log.replay([{ event: StateInitialised.make({ type: "StateInitialised", version: 1, initialState }) }]), /Trajectory logs require journal history/)
  } finally { log.dispose() }
}
