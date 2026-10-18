import { expect, test } from "bun:test"
import fc from "fast-check"
import { make as makeGrove, encodeReference, tree } from "@tardie/grove"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { AtomState } from "../src/initialise"
import type { ActorRuntime } from "../src/runtime/contracts"
import { createEventLog } from "../src/runtime/replay"
import { createActorStore } from "../src/runtime/execution"
import { defineActor } from "../src/actor/definition"
import { durableAtom } from "../src/atoms/durable/atom"
import { act } from "../src/atoms/act"
import { effectAtom } from "../src/atoms/effect"
import { prepareDocumentInput, documentSession } from "../src/services/tree-state"
import type { Journal, Recorded, StoredCheckpoint } from "../src/services/journal"
import { incrementalDecoder } from "../src/atoms/incremental/decode"
import { ReplayContext } from "../src/services/event-log"

test("runtime restores checkpoints and replays the suffix", async () => {
  const Added = Schema.Struct({ type: Schema.Literal("Added"), amount: Schema.Int })
  type Event = typeof Added.Type
  let records: readonly Recorded<Event>[] = []
  let fullReads = 0
  let saved: StoredCheckpoint | undefined
  const append = (position: number, batch: readonly Recorded<Event>[], checkpoint?: StoredCheckpoint) => Effect.sync(() => {
    if (position !== records.length) throw new Error("Journal conflict")
    records = [...records, ...batch]
    if (checkpoint) saved = checkpoint
  })
  const journal: Journal<Event> = {
    storedValues: documentSession({ load: () => { throw new Error("Missing test document") } }),
    read: Effect.sync(() => { fullReads++; return records }), readAfter: position => Effect.sync(() => records.slice(position)), readInputs: Effect.succeed([]),
    readCheckpoint: Effect.sync(() => saved),
    append: (position, batch) => append(position, batch), appendWithCheckpoint: append,
  }
  const actor = defineActor("counter", Effect.gen(function* () {
    const replay = Option.getOrThrow(yield* Effect.serviceOption(ReplayContext))
    const full = yield* replay.readFull
    expect(yield* replay.readFull).toBe(full)
    expect(full).toEqual(records)
    const state = durableAtom({ name: "total", input: Added, schema: Schema.Int, initial: 0, reduce: (n, event) => n + event.amount })
    return { schema: Added, atom: effectAtom(get => ({ view: get(state), events: {}, acts: {} })) }
  }))
  const { storedValues: _session, ...incomplete } = journal
  // @ts-expect-error Journal requires colocated synchronous document storage.
  const unsupported = createActorStore({ actor, journal: incomplete, services: () => Layer.empty, actorContext: Context.pick() })
  await expect(Effect.runPromise(unsupported)).rejects.toThrow("Journal requires colocated synchronous stored values")
  let send!: ActorRuntime<Event>["send"]
  const open = () => Effect.runPromise(createActorStore({ actor, journal, checkpoint: { mode: "manual" }, services: runtime => { send = runtime.send; return Layer.empty }, actorContext: Context.pick() }))
  let runtime = await open()
  try {
    await Effect.runPromise(send([{ type: "Added", amount: 2 }]))
    await Effect.runPromise(runtime.checkpoint)
    expect(saved?.payload instanceof Uint8Array).toBe(true)
    await Effect.runPromise(send([{ type: "Added", amount: 3 }]))
    await Effect.runPromise(runtime.close)
    runtime = await open()
    expect(runtime.getState().view).toBe(5)
    expect(fullReads).toBe(2)
    await Effect.runPromise(send([{ type: "Added", amount: 4 }]))
    expect(runtime.getState().view).toBe(9)
  } finally { await Effect.runPromise(runtime.close) }
})

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
    const transformed = durableAtom({ name: "encoded", input: Changed, schema: Schema.Struct({ n: Schema.FiniteFromString }), initial: { n: 42 }, reduce: state => state })
    expect(transformed[AtomState].encode(first.get(transformed))).toEqual({ n: "42" })
    expect(transformed[AtomState].decode({ n: "42" })).toEqual({ n: 42 })
  } finally { log.dispose() }
})

const State = Schema.Struct({ count: Schema.Int, messages: Schema.Array(Schema.Struct({ text: Schema.String })) })

test("tree inputs resolve captured snapshots after edits and commit", () => {
  const stored = new Map<string, string>()
  const session = documentSession({ options: { cacheBytes: 0 }, load: hash => {
    const text = stored.get(hash)
    if (text === undefined) throw new Error("Missing node")
    return text
  } })
  const binding = session.bind(State)
  const original = binding.initial({ count: 0, messages: [{ text: "before" }] })
  const selected = prepareDocumentInput({ context: original.select(["messages"]), count: 1 })
  expect(prepareDocumentInput({ z: original.select(["count"]), a: original.select(["messages"]) })).toEqual(prepareDocumentInput({ a: original.select(["messages"]), z: original.select(["count"]) }))
  const rootSelected = prepareDocumentInput(original.select([]))
  original.append(["messages"], [{ text: "after" }]).set(["count"], 1)
  const batch = session.staging.prepare(), staged = batch.nodes
  for (const [hash, node] of staged) stored.set(hash, node.text)
  session.staging.acknowledge(batch)
  expect(session.staging.prepare().nodes.size).toBe(0)
  expect(session.resolve(selected)).toEqual({ context: [{ text: "before" }], count: 1 })
  expect(session.resolve(rootSelected)).toEqual({ count: 0, messages: [{ text: "before" }] })
  expect(session.stats().cachedBytes).toBe(0)
})

test("projection and proposal roots survive advancement and release with their registries", () => {
  const Changed = Schema.Struct({ type: Schema.Literal("Changed"), value: Schema.Int })
  const documents = documentSession({ load: () => { throw new Error("Unexpected storage read") } })
  const state = durableAtom({ name: "value", schema: tree(Schema.Struct({ value: Schema.Int })), input: Changed, initial: { value: 0 }, reduce: (state, event) => state.set(["value"], event.value) })
  const Job = act({ name: "capture", input: Schema.Struct({ value: Schema.Int }), success: Schema.Int, failure: Schema.String })
  let captured: ReturnType<typeof Job.requestTree> | undefined
  const node = effectAtom(get => {
    const current = get(state)
    captured ??= Job.requestTree({ input: { value: current.select(["value"]) } })
    return { view: current.read(["value"]), events: {}, acts: { job: captured } }
  })
  const log = createEventLog({ schema: Changed, atoms: { node }, documents })
  try {
    const first = log.replay([{ event: { type: "Changed", value: 1 } }])
    const selection = first.effects()[0]!.request.selections![0]!
    const original = selection.reference
    const next = log.append(first, { type: "Changed", value: 2 })
    expect(next.view().node.view).toBe(2)
    expect(documents.held()).toContain(original)
    expect(documents.resolve(next.effects()[0]!.request)).toEqual({ value: 0 })
    log.discard(next)
    expect(documents.held()).toHaveLength(0)
    for (let value = 3; value <= 7; value++) {
      const snapshot = log.replay([{ event: { type: "Changed", value } }])
      expect(documents.held()).toContain(encodeReference(snapshot.get(state).reference!))
      expect(documents.held()).toContain(original)
      log.discard(snapshot)
      expect(documents.held()).toHaveLength(0)
    }
    log.replay([{ event: { type: "Changed", value: 8 } }])
  } finally { log.dispose() }
  expect(documents.held()).toHaveLength(0)
})


test("Grove immutable values retain input validation while reusing valid subtrees", () => {
  fc.assert(fc.property(fc.integer(), value => {
    const grove = makeGrove({ scope: "input-validation", load: () => { throw new Error("Unexpected cold read") } })
    const input = grove.bind(Schema.Struct({ value: Schema.Int })).initial({ value }).read([])
    const decode = incrementalDecoder(Schema.Struct({ value: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }))
    const result = decode(input)
    if (value < 0) expect(result).toBeUndefined()
    else expect(result?.value).toBe(input)
    expect(Object.isFrozen(input)).toBe(true)
  }), { numRuns: 100, includeErrorInReport: true })
})
