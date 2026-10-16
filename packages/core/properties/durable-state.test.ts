import { durableLogAtom, type Log } from "../src/atoms/durable/log"
import { logRegistry, logSelectionReference } from "../src/services/log-state"
import { expect, test } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
import { AtomState } from "../src/initialise"
import type { ActorRuntime } from "../src/runtime/contracts"
import { createEventLog } from "../src/runtime/replay"
import { createActorStore } from "../src/runtime/execution"
import { defineActor } from "../src/actor/definition"
import { durableAtom } from "../src/atoms/durable/atom"
import { act } from "../src/atoms/act"
import { effectAtom } from "../src/atoms/effect"
import { durableMerkleAtom } from "../src/atoms/durable/merkle"
import { prepareTreeInput, treeSession } from "../src/services/tree-state"
import type { Journal, Recorded, StoredCheckpoint, TreeCheckpoint } from "../src/services/journal"
import { checkpointEncoder, checkpointDigest, decodeCheckpoint, encodeCheckpoint } from "../src/services/checkpoint"

test("tree and byte checkpoints restore identical state", async () => {
  const history = Object.freeze(Array.from({ length: 100000 }, (_, n) => Object.freeze({ n, text: `message ${n}` })))
  const state = Object.freeze({ history, status: "idle" })
  const encode = checkpointEncoder()
  const checkpoint = { position: 1, durable: [{ name: "history", state, position: 1 }], operations: [] }
  const original = encode(checkpoint)
  expect(decodeCheckpoint(original)).toEqual(decodeCheckpoint(encodeCheckpoint(checkpoint)))
  expect(await Effect.runPromise(checkpointDigest(original))).toBe(original.root)
  const next = encode({ ...checkpoint, position: 2, durable: [{ name: "history", state: Object.freeze({ history, status: "ready" }), position: 2 }] })
  expect(next.metrics.hashedBytes).toBeLessThan(20000)
  expect(next.metrics.reusedNodes).toBeGreaterThan(0)
  expect(original.logicalBytes).toBe(encodeCheckpoint(checkpoint).byteLength)
  expect(decodeCheckpoint(original).position).toBe(1)
  expect(() => encode({ ...checkpoint, durable: [{ name: "history", state: undefined, position: 1 }] })).toThrow("JSON")
  expect(() => encode({ ...checkpoint, durable: [{ name: "history", state, position: 0 }] })).toThrow("position")
})

for (const tree of [false, true]) {
  test(`runtime restores ${tree ? "tree" : "byte"} checkpoints and replays the suffix`, async () => {
    const Added = Schema.Struct({ type: Schema.Literal("Added"), amount: Schema.Int })
    type Event = typeof Added.Type
    let records: readonly Recorded<Event>[] = []
    let saved: StoredCheckpoint | TreeCheckpoint | undefined
    const append = (position: number, batch: readonly Recorded<Event>[], checkpoint?: StoredCheckpoint | TreeCheckpoint) => Effect.sync(() => {
      if (position !== records.length) throw new Error("Journal conflict")
      records = [...records, ...batch]
      if (checkpoint) saved = checkpoint
    })
    const journal: Journal<Event> = {
      read: Effect.sync(() => records), readAfter: position => Effect.sync(() => records.slice(position)), readInputs: Effect.succeed([]),
      readCheckpoint: Effect.sync(() => saved?.payload instanceof Uint8Array ? { ...saved, payload: saved.payload } : undefined),
      append: (position, batch) => append(position, batch), appendWithCheckpoint: append,
      ...(tree ? { treeCheckpoint: { read: Effect.sync(() => saved), append } } : {}),
    }
    const actor = defineActor("counter", Effect.sync(() => {
      const state = durableAtom({ name: "total", input: Added, schema: Schema.Int, initial: 0, reduce: (n, event) => n + event.amount })
      return { schema: Added, atom: effectAtom(get => ({ view: get(state), events: {}, acts: {} })) }
    }))
    let send!: ActorRuntime<Event>["send"]
    const open = () => Effect.runPromise(createActorStore({ actor, journal, checkpoint: { mode: "manual" }, services: runtime => { send = runtime.send; return Layer.empty }, actorContext: Context.pick() }))
    let runtime = await open()
    try {
      await Effect.runPromise(send([{ type: "Added", amount: 2 }]))
      await Effect.runPromise(runtime.checkpoint)
      expect(saved?.payload instanceof Uint8Array).toBe(!tree)
      await Effect.runPromise(send([{ type: "Added", amount: 3 }]))
      await Effect.runPromise(runtime.close)
      runtime = await open()
      expect(runtime.getState().view).toBe(5)
    } finally { await Effect.runPromise(runtime.close) }
  })
}

test("durable checkpoint encoding preserves shared JSON subtrees", () => {
  const Changed = Schema.Struct({ type: Schema.Literal("Changed") })
  const state = durableAtom({
    name: "history", input: Changed,
    schema: Schema.Struct({ history: Schema.Array(Schema.Struct({ n: Schema.Int })), status: Schema.String }),
    initial: { history: Array.from({ length: 10000 }, (_, n) => ({ n })), status: "idle" },
    reduce: state => ({ ...state, status: "ready" }),
  })
  const root = effectAtom(get => ({ view: get(state), events: {}, acts: {} }))
  const log = createEventLog({ schema: Changed, atoms: { root } })
  try {
    const first = log.initial
    const captured = first.checkpoint()!
    expect(captured.durable[0]!.state).toBe(first.view().root.view)
    const next = log.append(first, { type: "Changed" })
    const updated = next.checkpoint()!
    expect(updated.durable[0]!.state).toBe(next.view().root.view)
    const encode = checkpointEncoder()
    encode(captured)
    expect(encode(updated).metrics.hashedBytes).toBeLessThan(20000)
    const transformed = durableAtom({ name: "encoded", input: Changed, schema: Schema.Struct({ n: Schema.FiniteFromString }), initial: { n: 42 }, reduce: state => state })
    expect(transformed[AtomState].encode(first.get(transformed))).toEqual({ n: "42" })
    expect(transformed[AtomState].decode({ n: "42" })).toEqual({ n: 42 })
  } finally { log.dispose() }
})

const State = Schema.Struct({ count: Schema.Int, messages: Schema.Array(Schema.Struct({ text: Schema.String })) })

test("tree inputs resolve captured snapshots after edits and commit", () => {
  const stored = new Map<string, string>()
  const session = treeSession({ options: { cacheBytes: 0 }, load: hash => {
    const text = stored.get(hash)
    if (text === undefined) throw new Error("Missing node")
    return text
  } })
  const binding = session.bind(State)
  const original = binding.initial({ count: 0, messages: [{ text: "before" }] })
  const selected = prepareTreeInput({ context: original.select(["messages"]), count: 1 })
  expect(prepareTreeInput({ z: original.select(["count"]), a: original.select(["messages"]) })).toEqual(prepareTreeInput({ a: original.select(["messages"]), z: original.select(["count"]) }))
  const rootSelected = prepareTreeInput(original.select([]))
  original.append(["messages"], [{ text: "after" }]).set(["count"], 1)
  const staged = session.nodes()
  for (const [hash, node] of staged) stored.set(hash, node.text)
  session.committed(staged)
  expect(session.nodes().size).toBe(0)
  expect(session.resolve(selected)).toEqual({ context: [{ text: "before" }], count: 1 })
  expect(session.resolve(rootSelected)).toEqual({ count: 0, messages: [{ text: "before" }] })
  expect(session.stats().cachedBytes).toBe(0)
})

test("projection and proposal roots survive advancement and release with their registries", () => {
  const Changed = Schema.Struct({ type: Schema.Literal("Changed"), value: Schema.Int })
  const trees = treeSession({ load: () => { throw new Error("Unexpected storage read") } })
  const state = durableMerkleAtom({ name: "value", schema: Schema.Struct({ value: Schema.Int }), input: Changed, initial: { value: 0 }, reduce: (state, event) => state.set(["value"], event.value) })
  const Job = act({ name: "capture", input: Schema.Struct({ value: Schema.Int }), success: Schema.Int, failure: Schema.String })
  let captured: ReturnType<typeof Job.requestTree> | undefined
  const node = effectAtom(get => {
    const current = get(state)
    captured ??= Job.requestTree({ input: { value: current.select(["value"]) } })
    return { view: current.read(["value"]), events: {}, acts: { job: captured } }
  })
  const log = createEventLog({ schema: Changed, atoms: { node }, trees })
  try {
    const first = log.replay([{ event: { type: "Changed", value: 1 } }])
    const selection = first.effects()[0]!.request.selections![0]!
    if (!("root" in selection)) throw new Error("Expected tree selection")
    const original = selection.root
    const next = log.append(first, { type: "Changed", value: 2 })
    expect(next.view().node.view).toBe(2)
    expect(trees.held()).toContain(original)
    expect(trees.resolve(next.effects()[0]!.request)).toEqual({ value: 0 })
    log.discard(next)
    expect(trees.held()).toHaveLength(0)
    for (let value = 3; value <= 7; value++) {
      const snapshot = log.replay([{ event: { type: "Changed", value } }])
      expect(trees.held()).toContain(snapshot.get(state).root)
      expect(trees.held()).toContain(original)
      log.discard(snapshot)
      expect(trees.held()).toHaveLength(0)
    }
    log.replay([{ event: { type: "Changed", value: 8 } }])
  } finally { log.dispose() }
  expect(trees.held()).toHaveLength(0)
})

test("log generations accept replayed prefixes and reject divergent versions", () => {
  const Added = Schema.Struct({ type: Schema.Literal("Added"), text: Schema.String })
  const history = durableLogAtom({ name: "history", entry: Schema.String, meta: { schema: Schema.Struct({ count: Schema.Int }), initial: { count: 0 } }, input: Added, reduce: (state, event) => ({ ...state, log: state.log.append([event.text]) }) })
  const registry = logRegistry()
  const events = createEventLog({ schema: Added, atoms: { history }, logs: registry })
  try {
    const initial = events.initial
    const a = events.append(initial, { type: "Added", text: "A" })
    const original = a.get(history).log
    const selected = logSelectionReference(original.select(0, 1))!
    expect(registry.read(selected)).toEqual(["A"])
    expect(events.append(initial, { type: "Added", text: "A" }).get(history).log.slice(0, 1)).toEqual(["A"])
    expect(() => events.append(initial, { type: "Added", text: "B" }).get(history)).toThrow("Conflicting log generation")
    original.append(["B"]).append(["C"])
    expect(() => original.append(["D", "E"])).toThrow("Conflicting log generation")
    expect(registry.read(selected)).toEqual(["A"])
    const restarted = original.restart(["replacement"])
    expect(registry.read(logSelectionReference(restarted.select(0, 1))!)).toEqual(["replacement"])
  } finally { events.dispose() }
})

test("log metadata validates its initial value and snapshots the configuration", () => {
  const Added = Schema.Struct({ type: Schema.Literal("Added") })
  const meta = Schema.Struct({ count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })
  const options = { name: "initial", entry: Schema.String, input: Added, meta: { schema: meta, initial: { count: -1 } }, reduce: (state: { readonly log: Log<string>; readonly meta: { readonly count: number } }) => state }
  expect(() => durableLogAtom(options)).toThrow()
  const initial = { count: 0 }
  const history = durableLogAtom({ ...options, meta: { schema: meta, initial } })
  expect(() => durableLogAtom({ ...options, meta: { schema: meta, initial }, chunkItems: 0 })).toThrow("chunkItems")
  initial.count = -1
  const events = createEventLog({ schema: Added, atoms: { history } })
  try { expect(events.initial.get(history).meta).toEqual({ count: 0 }) } finally { events.dispose() }
})

test("log entries and headers freeze descendants of already-frozen containers", () => {
  const Added = Schema.Struct({ type: Schema.Literal("Added") })
  const entry = Object.freeze({ nested: { count: 0 } })
  const meta = Object.freeze({ nested: { count: 1 } })
  const history = durableLogAtom({ name: "frozen", entry: Schema.Struct({ nested: Schema.Struct({ count: Schema.Int }) }), input: Added, meta: { schema: Schema.Struct({ nested: Schema.Struct({ count: Schema.Int }) }), initial: { nested: { count: 0 } } }, reduce: state => ({ log: state.log.append([entry]), meta }) })
  const events = createEventLog({ schema: Added, atoms: { history } })
  try {
    const state = events.append(events.initial, { type: "Added" }).get(history)
    expect(Object.isFrozen(state.log.at(0).nested)).toBe(true)
    expect(Object.isFrozen(state.meta.nested)).toBe(true)
    expect(() => { entry.nested.count = 2 }).toThrow()
    expect(() => { meta.nested.count = 3 }).toThrow()
    expect(state.log.at(0).nested.count).toBe(0)
    expect(state.meta.nested.count).toBe(1)
  } finally { events.dispose() }
})


test("log checkpoints restore a lazy immutable prefix and stage only new rows", () => {
  const Added = Schema.Struct({ type: Schema.Literal("Added"), count: Schema.Int })
  const history = durableLogAtom({ name: "stored", chunkItems: 2, cacheChunks: 1, entry: Schema.Struct({ nested: Schema.Struct({ count: Schema.Int }) }), input: Added, meta: { schema: Schema.Struct({ count: Schema.Int }), initial: { count: 0 } }, reduce: (state, event) => ({ ...state, log: state.log.append([{ nested: { count: event.count } }]) }) })
  let loads = 0
  const rows = new Map<number, unknown>()
  const storage = { load: (_name: string, start: number, end: number) => { loads++; return Array.from({ length: end - start }, (_, index) => Object.freeze({ nested: { count: (rows.get(start + index) as { nested: { count: number } }).nested.count } })) } }
  const logs = logRegistry(storage)
  const original = createEventLog({ schema: Added, atoms: { history }, logs })
  let stored: unknown
  try {
    const snapshot = original.append(original.initial, { type: "Added", count: 1 })
    stored = history[AtomState].encode(snapshot.get(history))
    const changes = logs.staged()
    for (const entry of changes.entries) rows.set(entry.index, entry.value)
    logs.committed(changes)
    expect(logs.staged().entries).toEqual([])
  } finally { original.dispose() }
  const recovered = logRegistry(storage)
  const replay = createEventLog({ schema: Added, atoms: { history }, logs: recovered, checkpoint: { position: 0, durable: [{ name: "stored", state: stored, position: 0 }], operations: [] } })
  try {
    const state = replay.initial.get(history)
    expect(state.log.length).toBe(1)
    expect(loads).toBe(0)
    const next = state.log.append([{ nested: { count: 2 } }, { nested: { count: 3 } }, { nested: { count: 4 } }])
    expect(recovered.staged().entries).toEqual([2, 3, 4].map((count, index) => ({ log: next.name, index: index + 1, value: { nested: { count } } })))
    expect(next.slice(1, 4)).toEqual([2, 3, 4].map(count => ({ nested: { count } })))
    expect(loads).toBe(0)
    const entry = state.log.at(0)
    expect(Object.isFrozen(entry.nested)).toBe(true)
    expect(Reflect.set(entry.nested, "count", 3)).toBe(false)
    expect(recovered.read(logSelectionReference(state.log.select(0, 1))!)).toEqual([{ nested: { count: 1 } }])
  } finally { replay.dispose() }
})


test("log reducers reject another atom's log", () => {
  const Added = Schema.Struct({ type: Schema.Literal("Added") })
  const foreign = durableLogAtom({ name: "foreign", entry: Schema.String, input: Added, meta: { schema: Schema.Struct({}), initial: {} }, reduce: state => state })
  let other!: Log<string>
  const history = durableLogAtom({ name: "history", entry: Schema.String, input: Added, meta: { schema: Schema.Struct({}), initial: {} }, reduce: state => ({ ...state, log: other }) })
  const events = createEventLog({ schema: Added, atoms: { foreign, history }, logs: logRegistry() })
  try {
    const initial = events.initial
    other = initial.get(foreign).log
    expect(() => events.append(initial, { type: "Added" }).get(history)).toThrow("foreign log")
  } finally { events.dispose() }
})
