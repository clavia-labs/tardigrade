import * as fc from "fast-check"
import { isDeepStrictEqual } from "node:util"
import { Context, Effect, Layer, Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { actorMethod, atom, event, createActorStore, createEventLog, createStore, decodeCheckpoint, defineActor, durableAtom, effectAtom, encodeCheckpoint, EventLog, RuntimeError, type Atom, type AtomReplay, type MessageJournal, type Recorded } from "@clavia/tardigrade-core"

const Added = event({ type: "Added", amount: Schema.Int })
const copies: readonly ((node: Atom<number>) => Atom<number>)[] = [node => node, NativeAtom.withLabel("copy"), NativeAtom.keepAlive]
const total = () => durableAtom({ name: "probe.total", input: Added, schema: Schema.Int, initial: 0, reduce: (state, event) => state + event.amount })

export const atomCheckpoint = fc.property(fc.uniqueArray(fc.nat({ max: copies.length - 1 }), { minLength: 1 }), fc.array(fc.integer({ min: -5, max: 5 }), { maxLength: 8 }), fc.boolean(), (reads, amounts, collide) => {
  lazyCheckpoint(amounts)
  windowedReplay(amounts)
  const original = total()
  const exposed = [...reads.map(index => copies[index]!(original)), ...(collide ? [total()] : [])]
  const options = { schema: Added, atoms: { root: effectAtom(get => ({ view: exposed.map(node => get(node)), events: {}, acts: {} })) } }
  const log = createEventLog(options)
  try {
    const snapshots = [log.initial]
    for (const amount of amounts) snapshots.push(log.append(snapshots.at(-1)!, { type: "Added", amount }))
    if (collide) {
      try { snapshots[0]!.checkpoint() } catch (error) { if (String(error).includes("Duplicate durable atom checkpoint name")) return; throw error }
      throw new Error("Distinct atoms sharing a name were captured")
    }
    for (const [cut, snapshot] of snapshots.entries()) {
      const captured = snapshot.checkpoint()!
      if (!isDeepStrictEqual(captured.durable.map(entry => entry.state), [amounts.slice(0, cut).reduce((sum, amount) => sum + amount, 0)])) throw new Error("Checkpoint did not hold one folded entry")
      const restored = createEventLog({ ...options, checkpoint: decodeCheckpoint(encodeCheckpoint(captured)) })
      let resumed = restored.initial
      for (const amount of amounts.slice(cut)) resumed = restored.append(resumed, { type: "Added", amount })
      restored.dispose()
      if (!isDeepStrictEqual(resumed.view().root.view, snapshots.at(-1)!.view().root.view)) throw new Error("Checkpoint restore differs from full replay")
    }
  } finally { log.dispose() }
})

const Shown = event({ type: "Shown" })
const LazyEvent = Schema.Union([Added, Shown])

function windowedReplay(amounts: readonly number[]) {
  const journal: Recorded<typeof Added.Type>[] = []
  const ranges: number[] = []
  const frame = (position: number, batch: readonly Recorded<typeof Added.Type>[]): AtomReplay => ({
    position, seed: undefined,
    read: from => {
      ranges.push(from)
      return from >= position - batch.length ? batch.slice(from - (position - batch.length)) : journal.slice(from, position)
    },
  })
  const replay = atom(frame(0, []))
  const history = atom(() => { throw new Error("Durable atom read retained event history") })
  const node = durableAtom({ name: "windowed.total", input: Added, schema: Schema.Int, initial: 0, reduce: (state, event, metadata, position) => {
    if (metadata.recordedAt !== position + 100) throw new Error("Range replay lost metadata or absolute position")
    return state * 2 + event.amount
  } })
  const store = createStore(Context.make(EventLog, { events: history, replay }))
  let historical = frame(0, [])
  let historicalExpected = 0
  let expected = 0
  let cursor = 0
  try {
    if (store.get(node) !== 0) throw new Error("Empty replay lost initial state")
    for (const [index, amount] of [1, ...amounts, 3].entries()) {
      const record = { event: { type: "Added" as const, amount }, recordedAt: index + 100 }
      journal.push(record)
      const next = frame(journal.length, [record])
      store.set(replay, next)
      expected = expected * 2 + amount
      if (index % 2 === 0) {
        if (store.get(node) !== expected || ranges.at(-1) !== cursor) throw new Error("Atom replay did not resume from its state cursor")
        cursor = journal.length
        const reads = ranges.length
        if (store.get(node) !== expected || ranges.length !== reads) throw new Error("Unchanged atom replay reread its range")
        historical = next
        historicalExpected = expected
      }
    }
    if (store.get(node) !== expected) throw new Error("Atom replay lost a released batch")
    const old = createStore(Context.make(EventLog, { events: history, replay: atom(historical) }))
    try {
      if (old.get(node) !== historicalExpected) throw new Error("Historical range read included future journal events")
    } finally { old.dispose() }
    const lazy = createStore(Context.make(EventLog, { events: history, replay: atom(frame(journal.length, [])) }))
    try {
      if (lazy.get(node) !== expected) throw new Error("First atom read lost released journal batches")
    } finally { lazy.dispose() }
  } finally { store.dispose() }
}

function lazyCheckpoint(amounts: readonly number[]) {
  const visible = durableAtom({ name: "probe.visible", input: Shown, schema: Schema.Boolean, initial: false, reduce: () => true })
  const hidden = durableAtom({
    name: "probe.hidden", input: Added,
    schema: Schema.Struct({ total: Schema.Int, positions: Schema.Array(Schema.Int), times: Schema.Array(Schema.Int) }),
    initial: { total: 0, positions: [], times: [] },
    reduce: (state, event, metadata, position) => {
      if (Object.keys(metadata).some(key => key !== "recordedAt" && key !== "message")) throw new Error("Prefix exposed extra reducer metadata")
      return { total: state.total * 2 + event.amount, positions: [...state.positions, position], times: [...state.times, metadata.recordedAt ?? -1] }
    },
  })
  const options = { schema: LazyEvent, atoms: { root: effectAtom(get => ({ view: get(visible) ? get(hidden) : null, events: {}, acts: {} })) } }
  const records: Recorded<typeof LazyEvent.Type>[] = []
  const logs: ReturnType<typeof createEventLog<typeof LazyEvent.Type, typeof options.atoms>>[] = []
  const open = (extra: Partial<Parameters<typeof createEventLog<typeof LazyEvent.Type, typeof options.atoms>>[0]> = {}) => {
    const log = createEventLog({ ...options, ...extra })
    logs.push(log)
    return log
  }
  try {
    const full = open()
    let current = full.append(full.initial, { type: "Added", amount: 1 }, { recordedAt: 100 })
    records.push({ event: { type: "Added", amount: 1 }, recordedAt: 100 })
    const checkpoint = current.checkpoint()!
    if (checkpoint.durable.some(entry => entry.name === hidden.name)) throw new Error("Unread atom was captured")
    let reads = 0
    const restored = open({ checkpoint, readBefore: position => { reads++; return records.slice(0, position) } })
    let resumed = restored.initial
    for (const amount of amounts) {
      const event = { type: "Added" as const, amount }
      const metadata = { recordedAt: 100 + records.length }
      records.push({ event, ...metadata })
      current = full.append(current, event, metadata)
      resumed = restored.append(resumed, event, metadata)
    }
    const chainedCheckpoint = resumed.checkpoint()!
    const chained = open({ checkpoint: chainedCheckpoint, readBefore: position => records.slice(0, position) })
    if (reads !== 0) throw new Error("Checkpoint restore read the prefix before the atom was needed")
    const beforeShown = resumed
    current = full.append(current, { type: "Shown" })
    resumed = restored.append(resumed, { type: "Shown" })
    const chainedShown = chained.append(chained.initial, { type: "Shown" })
    const expected = current.view().root.view
    if (!isDeepStrictEqual(resumed.view().root.view, expected) || !isDeepStrictEqual(chainedShown.view().root.view, expected)) throw new Error("Lazy checkpoint restore differs from full replay")
    if (Number(reads) !== 1) throw new Error("Lazy atom did not load its prefix exactly once")
    const captured = resumed.checkpoint()!
    const seeded = open({ checkpoint: captured, readBefore: () => { throw new Error("Captured atom requested its prefix") } })
    if (!isDeepStrictEqual(seeded.initial.view().root.view, expected)) throw new Error("Captured lazy atom lost state")
    const event = { type: "Added" as const, amount: 3 }
    current = full.append(current, event)
    resumed = restored.append(resumed, event)
    if (!isDeepStrictEqual(resumed.view().root.view, current.view().root.view) || Number(reads) !== 1) throw new Error("Lazy atom repeated its prefix after another event")
    if (!isDeepStrictEqual(beforeShown.get(hidden), expected)) throw new Error("Historical lazy read included future events")
    for (const readBefore of [undefined, () => [], () => { throw new Error("Prefix unavailable") }]) {
      let rejected = false
      try {
        const broken = open({ checkpoint, ...(readBefore ? { readBefore } : {}) })
        broken.append(broken.initial, { type: "Shown" }).view()
      } catch { rejected = true }
      if (!rejected) throw new Error("Unavailable lazy atom prefix silently returned initial state")
    }
    const seededPrefix: Recorded<typeof LazyEvent.Type>[] = [
      { event: { type: "StateInitialised", version: 1, initialState: { [hidden.name]: { total: 7, positions: [], times: [] } } } },
      { event: { type: "Added", amount: 1 }, recordedAt: 44 },
    ]
    const omitted = open({ checkpoint: { position: 2, durable: [{ name: visible.name, position: 2, state: false }] }, readBefore: () => seededPrefix })
    if (!isDeepStrictEqual(omitted.append(omitted.initial, { type: "Shown" }).view().root.view, { total: 15, positions: [1], times: [44] })) throw new Error("Lazy prefix ignored initialised actor state")
    const acceptances = durableAtom({ name: "probe.acceptances", input: Schema.Unknown, schema: Schema.Int, initial: 0, reduce: (count, event) => {
      if (typeof event !== "object" || event === null || !("type" in event) || event.type !== "EffectRequested") return count
      if ("request" in event || "input" in event) throw new Error("Lazy atom observed a stored acceptance payload")
      return count + 1
    } })
    const ref = { seq: 0, atom: "root", act: "probe.work" }
    const completed = open({ checkpoint: { position: 2, durable: [{ name: visible.name, position: 2, state: false }] }, readBefore: () => [
      { event: { type: "EffectRequested", ref, request: { act: ref.act, input: { _tag: "InlineInput", value: "private input" } } } },
      { event: { type: "EffectSettled", ref, outcome: { status: "fulfilled", value: { type: "value", value: null } } } },
    ] })
    if (completed.initial.get(acceptances) !== 1) throw new Error("Lazy atom lost its acceptance observation")
    const indexed = open({ checkpoint: { position: 2, durable: [{ name: visible.name, position: 2, state: false }] }, readOperation: () => [
      { event: { type: "EffectRequested", ref, request: { act: ref.act, input: { _tag: "InlineInput", value: null } } } },
      { event: { type: "EffectSettled", ref, outcome: { status: "fulfilled", value: { type: "value", value: null } } } },
    ] })
    const settled = indexed.initial
    if (indexed.append(settled, { type: "EffectCancelled", ref, reason: null }) !== settled) throw new Error("Standalone recovery ignored its operation reader before a checkpoint")
  } finally { for (const log of logs) log.dispose() }
}

// lazyAtomRecovery checks omitted atom reads through the runtime registry and checkpoint replay on both SQL hosts (quint/checkpoint/lazyAtomCheckpoint.qnt, readyEquivalent).
export async function lazyAtomRecovery(fixture: { readonly open: () => MessageJournal<typeof LazyEvent.Type> & { readonly close: Effect.Effect<void, Error> } }) {
  let journal = fixture.open()
  let reads = 0
  let prefixPosition = 0
  const hidden = durableAtom({ name: "lazy.hidden", input: Added, schema: Schema.Int, initial: 0, reduce: (state, event) => state * 2 + event.amount })
  const visible = durableAtom({ name: "lazy.visible", input: Shown, schema: Schema.Boolean, initial: false, reduce: () => true })
  const actor = defineActor("lazy-checkpoint", Effect.succeed({ schema: LazyEvent, methods: {
    add: actorMethod({ inputSchema: Schema.Int, outputSchema: Schema.Null, onReceive: Added.from((amount: number) => ({ amount })), result: () => ({ status: "completed", output: null }) }),
    show: actorMethod({ inputSchema: Schema.Null, outputSchema: Schema.Null, onReceive: Shown.from(() => ({})), result: () => ({ status: "completed", output: null }) }),
  }, atom: effectAtom(get => ({ view: get(visible) ? get(hidden) : null, events: {}, acts: {} })) }))
  const open = () => Effect.runPromise(createActorStore({ actor, journal: { ...journal,
    read: () => { throw new RuntimeError("Runtime requested full history") },
    readAfter: () => { throw new RuntimeError("Runtime requested an unbounded suffix") },
    readBefore: () => { throw new RuntimeError("Runtime requested a full prefix") },
    readRange: (from, to) => { if (from < prefixPosition) reads++; return journal.readRange(from, to) },
  }, journalReadBatchSize: 2, checkpoint: { mode: "manual" }, actorContext: Context.pick(), services: () => Layer.empty }))
  let store = await open()
  try {
    await Effect.runPromise(store.receive({ method: "add", input: 1 }, { id: "first", from: { kind: "external", id: "test" } }))
    await Effect.runPromise(store.checkpoint)
    const checkpoint = decodeCheckpoint(journal.readCheckpoint()!.payload)
    prefixPosition = checkpoint.position
    if (checkpoint.durable.some(entry => entry.name === hidden.name)) throw new Error("Runtime checkpoint captured an unread atom")
    await Effect.runPromise(store.close)
    await Effect.runPromise(journal.close)
    journal = fixture.open()
    store = await open()
    await Effect.runPromise(store.receive({ method: "add", input: 3 }, { id: "second", from: { kind: "external", id: "test" } }))
    if (reads !== 0) throw new Error("Runtime eagerly loaded the checkpoint prefix")
    if (store.get(hidden) !== 5 || Number(reads) === 0) throw new Error("Runtime registry lost the omitted atom prefix")
    const loaded = reads
    if (store.get(hidden) !== 5 || reads !== loaded || store.snapshot().retainedRecords !== 0) throw new Error("Runtime retained history or repeated an unchanged atom read")
    await Effect.runPromise(store.receive({ method: "show", input: null }, { id: "show", from: { kind: "external", id: "test" } }))
    if (store.getState().view !== 5 || store.snapshot().get(hidden) !== 5) throw new Error("Runtime checkpoint replay lost lazy state")
    await Effect.runPromise(store.receive({ method: "add", input: 2 }, { id: "third", from: { kind: "external", id: "test" } }))
    if (store.getState().view !== 12 || store.get(hidden) !== 12) throw new Error("Runtime lazy state folded events twice")
    await Effect.runPromise(store.checkpoint)
    await Effect.runPromise(store.close)
    await Effect.runPromise(journal.close)
    journal = fixture.open()
    reads = 0
    store = await open()
    if (store.getState().view !== 12 || store.get(hidden) !== 12 || Number(reads) !== 0) throw new Error("Captured runtime atom reloaded its prefix")
  } finally { await Effect.runPromise(store.close); await Effect.runPromise(journal.close) }
}
