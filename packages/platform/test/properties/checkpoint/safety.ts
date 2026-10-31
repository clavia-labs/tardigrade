import { atomPopulation, atomPopulationKeys, Changed, type AtomPopulationKind } from "../../fixtures/atoms/population"
import { strict as assert } from "node:assert"
import * as fc from "fast-check"
import { isDeepStrictEqual } from "node:util"
import { Context, Schema } from "effect"
import { atom, atomCheckpointKey, event, createEventLog, createStore, decodeCheckpoint, effectAtom, encodeCheckpoint, EventLog, type AtomCheckpoint, type AtomReplay, type Recorded } from "@clavia/tardigrade-core"
import { checkpointAtom, checkpointIdentity, type CheckpointAtomKind } from "../../fixtures/atoms/atom"

const Added = event({ type: "Added", amount: Schema.Int })
const Shown = event({ type: "Shown" })
const LazyEvent = Schema.Union([Added, Shown])

// atomReplaySafety checks lazy prefixes, released batches, and reducer metadata through each constructor.
export const atomReplaySafety = (kind: CheckpointAtomKind) => fc.property(fc.array(fc.integer({ min: -5, max: 5 }), { maxLength: 8 }), amounts => {
  lazyCheckpoint(kind, amounts)
  windowedReplay(kind, amounts)
})

// atomCheckpointSafety checks independently scheduled atom populations against full replay at every recovery cut.
export const atomCheckpointSafety = (kind: AtomPopulationKind) => fc.property(fc.array(fc.record({
  id: fc.constantFrom(...atomPopulationKeys, "untracked"), amount: fc.integer({ min: -3, max: 3 }),
}), { minLength: 2, maxLength: 12 }), changes => {
  const population = atomPopulation(kind, "safety")
  const { members, expected } = population
  const options = { schema: Changed, atoms: { empty: atom(null) } }
  const log = createEventLog(options)
  const records: Recorded<Changed>[] = []
  const allRecords = changes.map(change => ({ event: { type: "Changed" as const, ...change } }))
  const cursors = new Map(members.map(member => [member.key, 0]))
  try {
    let current = log.initial
    for (const member of members) current.get(member.node)
    for (let cut = 0; cut <= changes.length; cut++) {
      const selected = cut === changes.length ? members[0]! : cut % 3 === 0 ? members[(cut / 3) % members.length]! : undefined
      if (selected) { current.get(selected.node); cursors.set(selected.key, cut) }
      const captured = current.checkpoint()!
      assert.equal(captured.durable.length, members.length)
      for (const member of members) {
        const entry = captured.durable.find(entry => atomCheckpointKey(entry) === atomCheckpointKey(member.identity))!
        assert.equal(entry.position, cursors.get(member.key))
        assert.equal(entry.state, expected(member.key, records, entry.position))
      }
      if (cut === changes.length) {
        assert.equal(captured.durable.find(entry => atomCheckpointKey(entry) === atomCheckpointKey(members[0]!.identity))!.position, current.position)
        assert.ok(captured.durable.some(entry => entry.position < current.position))
      }
      const restored = createEventLog({ ...options, checkpoint: decodeCheckpoint(encodeCheckpoint(captured)), readBefore: position => records.slice(0, position) })
      try {
        let resumed = restored.initial
        for (const member of members) assert.equal(resumed.get(member.node), expected(member.key, records))
        for (const record of allRecords.slice(cut)) resumed = restored.append(resumed, record.event)
        for (const member of members) assert.equal(resumed.get(member.node), expected(member.key, allRecords))
      } finally { restored.dispose() }
      if (cut < changes.length) {
        const record = allRecords[cut]!
        records.push(record)
        current = log.append(current, record.event)
      }
    }
  } finally { log.dispose() }
})

// atomCheckpointValidation rejects isolated snapshot defects after valid recovery succeeds for each population.
export function atomCheckpointValidation(kind: AtomPopulationKind) {
  const { members, expected } = atomPopulation(kind, "validation")
  const records: Recorded<Changed>[] = [
    { event: { type: "Changed", id: "rick", amount: 1 } },
    { event: { type: "Changed", id: "morty", amount: 7 } },
    { event: { type: "Changed", id: "summer", amount: 9 } },
    { event: { type: "Changed", id: "rick", amount: 3 } },
  ]
  const open = (snapshot: AtomCheckpoint) => createEventLog({
    schema: Changed, atoms: { empty: atom(null) }, checkpoint: { position: records.length, durable: [] },
    readBefore: position => records.slice(0, position), readAtomCheckpoint: () => snapshot,
  })
  for (const member of members) {
    const valid = { ...member.identity, position: 2, state: expected(member.key, records, 2) }
    for (const position of [valid.position, records.length]) {
      const restored = open({ ...valid, position, state: expected(member.key, records, position) })
      try { assert.equal(restored.initial.get(member.node), expected(member.key, records)) }
      finally { restored.dispose() }
    }
    for (const invalid of [
      { snapshot: { ...valid, position: records.length, state: "invalid" }, message: undefined },
      { snapshot: { ...valid, name: "wrong-identity" }, message: "Invalid atom checkpoint" },
      { snapshot: { ...valid, position: records.length + 1 }, message: "Invalid atom checkpoint" },
    ]) {
      const broken = open(invalid.snapshot)
      try {
        assert.throws(() => broken.initial.get(member.node), error => error instanceof Error && (invalid.message === undefined || error.message === invalid.message))
      } finally { broken.dispose() }
    }
  }
}

function windowedReplay(kind: CheckpointAtomKind, amounts: readonly number[]) {
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
  const node = checkpointAtom(kind, { name: "windowed.total", input: Added, schema: Schema.Int, initial: 0, reduce: (state, event, metadata, position) => {
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

function lazyCheckpoint(kind: CheckpointAtomKind, amounts: readonly number[]) {
  const visible = checkpointAtom(kind, { name: "probe.visible", input: Shown, schema: Schema.Boolean, initial: false, reduce: () => true })
  const hidden = checkpointAtom(kind, {
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
    if (checkpoint.durable.some(entry => atomCheckpointKey(entry) === atomCheckpointKey(checkpointIdentity(hidden)))) throw new Error("Unread atom was captured")
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
    const omitted = open({ checkpoint: { position: 2, durable: [{ ...checkpointIdentity(visible), position: 2, state: false }] }, readBefore: () => seededPrefix })
    if (!isDeepStrictEqual(omitted.append(omitted.initial, { type: "Shown" }).view().root.view, { total: 15, positions: [1], times: [44] })) throw new Error("Lazy prefix ignored initialised actor state")
    const acceptances = checkpointAtom(kind, { name: "probe.acceptances", input: Schema.Unknown, schema: Schema.Int, initial: 0, reduce: (count, event) => {
      if (typeof event !== "object" || event === null || !("type" in event) || event.type !== "EffectRequested") return count
      if ("request" in event || "input" in event) throw new Error("Lazy atom observed a stored acceptance payload")
      return count + 1
    } })
    const ref = { seq: 0, atom: "root", act: "probe.work" }
    const completed = open({ checkpoint: { position: 2, durable: [{ ...checkpointIdentity(visible), position: 2, state: false }] }, readBefore: () => [
      { event: { type: "EffectRequested", ref, request: { act: ref.act, input: { _tag: "InlineInput", value: "private input" } } } },
      { event: { type: "EffectSettled", ref, outcome: { status: "fulfilled", value: { type: "value", value: null } } } },
    ] })
    if (completed.initial.get(acceptances) !== 1) throw new Error("Lazy atom lost its acceptance observation")
    const indexed = open({ checkpoint: { position: 2, durable: [{ ...checkpointIdentity(visible), position: 2, state: false }] }, readOperation: () => [
      { event: { type: "EffectRequested", ref, request: { act: ref.act, input: { _tag: "InlineInput", value: null } } } },
      { event: { type: "EffectSettled", ref, outcome: { status: "fulfilled", value: { type: "value", value: null } } } },
    ] })
    const settled = indexed.initial
    if (indexed.append(settled, { type: "EffectCancelled", ref, reason: null }) !== settled) throw new Error("Standalone recovery ignored its operation reader before a checkpoint")
  } finally { for (const log of logs) log.dispose() }
}

