import fc from "fast-check"
import { Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { appendOnly, encodeReference, type ValueReference } from "@tardie/grove"
import { type SyncSqlite } from "@tardie/grove/sqlite"
import { makeLegacySync as makeSync } from "../../src/storage/sqlite/store"

const Item = Schema.Struct({ text: Schema.String, notes: Schema.Array(Schema.String), note: Schema.optionalKey(Schema.String) })
export const AppendState = Schema.Struct({
  events: appendOnly(Schema.Array(Item)).annotate({ title: "Immutable event entries" }),
  audit: appendOnly(Schema.Array(Schema.String)),
  groups: Schema.Array(Schema.Struct({ entries: appendOnly(Schema.Array(Schema.String)) })),
  ordinary: Schema.Array(Schema.String),
})
export interface AppendCase {
  readonly initial: readonly string[]
  readonly edits: readonly { readonly kind: "append" | "replace" | "batch" | "rollback" | "branch"; readonly values: readonly string[] }[]
  readonly pageItems: number
  readonly fanout: number
  readonly cacheBytes: number
}

export const appendCases = fc.record({ initial: fc.array(fc.string(), { maxLength: 12 }), edits: fc.array(fc.record({ kind: fc.constantFrom("append", "replace", "batch", "rollback", "branch"), values: fc.array(fc.string(), { maxLength: 5 }) }), { minLength: 5, maxLength: 20 }), pageItems: fc.integer({ min: 2, max: 8 }), fanout: fc.integer({ min: 2, max: 5 }), cacheBytes: fc.constantFrom(0, 128, 8192) })


// appendOnlyScenario compares retained document versions with JSON through native commit, rollback, branching, collection and reopen (../storage.test.ts; ../workerd/properties.workers.ts).
export function appendOnlyScenario(driver: SyncSqlite, options: AppendCase) {
  const config = { scope: "append-only", pageItems: options.pageItems, fanout: options.fanout, cacheBytes: options.cacheBytes, leafBytes: 128, tailBytes: 32 }
  const open = () => makeSync(driver, config)
  let store = open()
  let model = { events: options.initial.map(text => ({ text, notes: [] as string[] })), audit: [] as string[], groups: [{ entries: ["first"] }], ordinary: ["editable"] }
  let view = store.bind(AppendState).initial(model)
  const snapshots: { readonly reference: ValueReference<unknown>; readonly value: typeof model }[] = []
  const same = (actual: unknown, expected: unknown) => { if (!isDeepStrictEqual(actual, expected)) throw new Error("Append-only document differs from JSON model") }
  store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: null, document: view }] }))
  for (const [index, edit] of options.edits.entries()) {
    const before = view.reference, saved = structuredClone(model), pin = `pin-${index}`
    store.transaction(tx => store.commit(tx, { retain: [{ owner: pin, selection: view.select([]) }] }))
    snapshots.push({ reference: before, value: saved })
    const entries = edit.values.map(text => ({ text, notes: [] as string[] }))
    let next = edit.kind === "replace" ? view.set(["events"], entries) : view.batch(edit => {
      edit.append(["events"], entries)
      edit.append(["audit"], [String(index)])
      edit.set(["groups", 0], { entries: [String(index)] })
    })
    const expected = edit.kind === "replace" ? { ...model, events: entries } : { ...model, events: [...model.events, ...entries], audit: [...model.audit, String(index)], groups: [{ entries: [String(index)] }] }
    if (edit.kind === "branch") {
      const branch = store.bind(AppendState).open(snapshots[0]!.reference).append(["events"], entries)
      same(branch.read(["events"]), [...snapshots[0]!.value.events, ...entries])
      same(next.read([]), expected)
    }
    if (edit.kind === "rollback") {
      let failed = false
      try { store.transaction(tx => { store.commit(tx, { publish: [{ owner: "head", expected: before, document: next }] }); throw new Error("Injected append rollback") }) } catch { failed = true }
      if (!failed) throw new Error("Append-only rollback committed")
      same(encodeReference(store.owner("head")!), encodeReference(before))
      same(store.view(store.owner("head")!, AppendState).materialize(), model)
    }
    store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: before, document: next }] }))
    model = expected
    store = open()
    store.collect()
    next = store.bind(AppendState).open(store.owner("head")!)
    same(next.read([]), model)
    same(next.slice(["events"], Math.min(1, next.length(["events"])), next.length(["events"])), model.events.slice(1))
    same([...store.view(store.owner("head")!, AppendState).scan(["events"])], model.events)
    for (const snapshot of snapshots) same(store.view(snapshot.reference, AppendState).materialize(), snapshot.value)
    view = next
  }
  for (const [index, snapshot] of snapshots.entries()) store.transaction(tx => store.commit(tx, { release: [{ owner: `pin-${index}`, expected: snapshot.reference }] }))
  store.collect()
  same(store.view(store.owner("head")!, AppendState).materialize(), model)
}

export const rowCases = fc.record({ values: fc.array(fc.string(), { minLength: 1, maxLength: 8 }), suffix: fc.array(fc.string(), { minLength: 1, maxLength: 5 }), chunkBytes: fc.constantFrom(1, 3, 17, 4096), rowBatchItems: fc.integer({ min: 1, max: 5 }), cacheBytes: fc.constantFrom(0, 128, 8192) })

// rowLogScenario exercises prefix reuse, replay identity, pending dependencies, native rollback and live scans against both SQLite adapters (../storage.test.ts; ../workerd/properties.workers.ts).
export function rowLogScenario(driver: SyncSqlite, options: typeof rowCases extends fc.Arbitrary<infer Value> ? Value : never) {
  const config = { scope: "row-lifetimes", chunkBytes: options.chunkBytes, maxParameters: 5, rowBatchItems: options.rowBatchItems, cacheBytes: options.cacheBytes }
  const open = () => makeSync(driver, config), store = open(), peer = open(), schema = appendOnly(Schema.Array(Schema.String))
  const same = (actual: unknown, expected: unknown) => { if (!isDeepStrictEqual(actual, expected)) throw new Error("Row-log lifetime differs from JSON model") }
  const publish = (document: { readonly reference: ValueReference<unknown> }) => store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: store.owner("head"), document }] }))
  const initial = store.bind(schema).initial(options.values), extra = options.suffix.map(text => "A:" + text), rival = options.suffix.map(text => "B:" + text)
  publish(initial)
  store.transaction(tx => store.commit(tx, { retain: [{ owner: "prefix", selection: initial.reference }] }))
  const first = initial.append([], extra), firstRef = encodeReference(first.reference)
  publish(first)
  same([...store.view(first.reference, schema).scan([])], [...options.values, ...extra])
  store.transaction(tx => store.commit(tx, { release: [{ owner: "head", expected: first.reference }] }))
  peer.collect()
  const second = store.bind(schema).open(initial.reference).append([], rival)
  publish(second)
  same(store.bind(schema).open(second.reference).read([]), [...options.values, ...rival])
  const replay = peer.bind(schema).open(initial.reference).append([], extra)
  same(encodeReference(replay.reference), firstRef)
  peer.transaction(tx => peer.commit(tx, { retain: [{ owner: "replay", selection: replay.reference }] }))
  same(peer.view(replay.reference, schema).materialize(), [...options.values, ...extra])
  peer.transaction(tx => peer.commit(tx, { release: [{ owner: "replay", expected: replay.reference }] }))
  peer.discard()
  // A draft created after its parent's commit must survive that parent's staging acknowledgement and collection.
  const holder = {}, parent = second.append([], ["parent"])
  let draft = parent
  store.transaction(tx => {
    store.commit(tx, { publish: [{ owner: "head", expected: second.reference, document: parent }] })
    draft = parent.append([], ["child"])
    store.hold(holder, "draft", draft.reference)
  })
  const replacement = store.bind(schema).initial(["replacement"])
  publish(replacement)
  store.discard(); peer.collect()
  same(draft.read([]), [...options.values, ...rival, "parent", "child"])
  publish(draft)
  store.release(holder); store.discard(); peer.collect()
  same(store.view(draft.reference, schema).materialize(), [...options.values, ...rival, "parent", "child"])
  // A child created after an uncommitted parent must keep the parent's pending rows when the transaction rolls back.
  let rolled = draft
  try {
    store.transaction(tx => {
      const parent = draft.append([], ["rollback-parent"])
      store.commit(tx, { publish: [{ owner: "head", expected: draft.reference, document: parent }] })
      rolled = parent.append([], ["rollback-child"])
      store.hold(holder, "rolled", rolled.reference)
      throw new Error("Injected row rollback")
    })
    throw new Error("Rollback did not throw")
  } catch (cause) { if (!(cause instanceof Error) || cause.message !== "Injected row rollback") throw cause }
  store.discard(); peer.collect()
  same(rolled.read([]), [...options.values, ...rival, "parent", "child", "rollback-parent", "rollback-child"])
  publish(rolled)
  store.release(holder); store.discard()
  const iterator = store.view(rolled.reference, schema).scan([]), firstItem = iterator.next()
  store.transaction(tx => store.commit(tx, { release: [{ owner: "head", expected: rolled.reference }] }))
  peer.collect()
  same([firstItem.value, ...iterator], [...options.values, ...rival, "parent", "child", "rollback-parent", "rollback-child"])
  store.transaction(tx => store.commit(tx, { release: [{ owner: "prefix", expected: initial.reference }] }))
  store.discard(); peer.discard(); peer.collect()
  for (const table of ["grove_value_rows", "grove_value_row_chunks", "grove_value_log_spans", "grove_value_log_manifests", "grove_value_nodes"]) {
    const row = driver.execute(`SELECT COUNT(*) n FROM ${table}`, [])[0]
    same(row?.n, 0)
  }
}

// rowCorruptionScenario rejects missing entries and incomplete UTF-8 chunks before yielding them (../storage.test.ts; ../workerd/properties.workers.ts).
export function rowCorruptionScenario(driver: SyncSqlite, suffix: string, chunkBytes: number, mode: "row" | "chunk" | "length") {
  const schema = appendOnly(Schema.Array(Schema.String)), store = makeSync(driver, { scope: "row-corruption", cacheBytes: 0, chunkBytes })
  const document = store.bind(schema).initial(["before", "\uFEFF\uFFFE界🙂".repeat(5) + suffix, "after"])
  store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: null, document }] }))
  if (!isDeepStrictEqual(store.view(document.reference, schema).materialize(), ["before", "\uFEFF\uFFFE界🙂".repeat(5) + suffix, "after"])) throw new Error("Unicode row changed")
  if (mode === "row") driver.execute("DELETE FROM grove_value_rows WHERE idx=1", [])
  else if (mode === "chunk") driver.execute("DELETE FROM grove_value_row_chunks WHERE idx=1 AND ordinal=0", [])
  else driver.execute("UPDATE grove_value_rows SET byte_length=byte_length+1 WHERE idx=1", [])
  try { store.view(document.reference, schema).materialize() } catch { return }
  throw new Error("Corrupt append-only row was accepted")
}
