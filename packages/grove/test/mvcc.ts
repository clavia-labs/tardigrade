import fc from "fast-check"
import { Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { keyValue, encodeReference, type ValueReference } from "@tardie/grove"
import { makeSync, type SyncSqlite } from "@tardie/grove/sqlite"

const Value = Schema.Struct({ text: Schema.String, items: Schema.Array(Schema.String) })
const State = keyValue(Value)
const keys = fc.constantFrom("", "a", "b", "__proto__", "constructor", "\uFEFFkey", "\uFFFEkey", "界", "🙂", "\uE000")
export const mvccCases = fc.record({ edits: fc.array(fc.record({ key: keys, text: fc.string(), remove: fc.boolean(), rollback: fc.boolean(), fork: fc.boolean() }), { minLength: 5, maxLength: 20 }), cacheBytes: fc.constantFrom(0, 256, 8192), chunkBytes: fc.constantFrom(1, 3, 17, 4096), rowBatchItems: fc.integer({ min: 1, max: 5 }) })
type Case = typeof mvccCases extends fc.Arbitrary<infer Value> ? Value : never
const same = (actual: unknown, expected: unknown) => { if (!isDeepStrictEqual(actual, expected)) throw new Error("MVCC snapshot differs from JSON model") }

// mvccScenario compares native version rows with JSON snapshots through forks, rollback, collection and reopen (mvcc.test.ts; workerd/mvcc.workers.ts).
export function mvccScenario(driver: SyncSqlite, options: Case) {
  const config = { scope: "mvcc", ...options, maxParameters: 5 }, open = () => makeSync(driver, config)
  let store = open(), model: typeof State.Type = { anchor: { text: "界🙂", items: [] } }, document = store.bind(State).initial(model)
  const saved: { reference: ValueReference<unknown>; value: typeof State.Type }[] = []
  store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: null, document }] }))
  for (const [index, edit] of options.edits.entries()) {
    const before = store.owner("head")!, source = edit.fork && saved.length ? store.bind(State).open(saved[0]!.reference) : document
    const previous = edit.fork && saved.length ? saved[0]!.value : model, expected = { ...previous }, value = { text: edit.text, items: ["界🙂\uFEFF\uFFFE", edit.text] }
    if (edit.remove) delete expected[edit.key]; else Object.defineProperty(expected, edit.key, { value, enumerable: true, configurable: true, writable: true })
    const next = edit.remove ? source.remove([edit.key]) : source.set([edit.key], value)
    const replayed = edit.remove ? source.remove([edit.key]) : source.set([edit.key], value)
    same(encodeReference(replayed.reference), encodeReference(next.reference))
    if (edit.rollback) {
      try { store.transaction(tx => { store.commit(tx, { publish: [{ owner: "head", expected: before, document: next }] }); throw new Error("Injected MVCC rollback") }); throw new Error("Missing rollback") } catch (cause) { if (!(cause instanceof Error) || cause.message !== "Injected MVCC rollback") throw cause }
      same(store.view(before, State).materialize(), model)
    }
    store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: before, document: next }], retain: [{ owner: `pin-${index}`, selection: next.reference }] }))
    saved.push({ reference: next.reference, value: expected }); model = expected
    store.discard(); store = open(); store.collect()
    document = store.bind(State).open(store.owner("head")!)
    const loaded = store.stats().loadedMapValues
    for (const key of ["", "absent", "__proto__", ...Object.keys(model)]) same(document.has([key]), Object.hasOwn(model, key))
    same(store.stats().loadedMapValues, loaded)
    same(document.read([]), model)
    same(Object.keys(document.read([])), Object.keys(model))
    for (const snapshot of saved) same(store.view(snapshot.reference, State).materialize(), snapshot.value)
  }
  for (const [index, snapshot] of saved.entries()) store.transaction(tx => store.commit(tx, { release: [{ owner: `pin-${index}`, expected: snapshot.reference }] }))
  store.transaction(tx => store.commit(tx, { release: [{ owner: "head", expected: document.reference }] }))
  store.discard(); store.collect()
  for (const table of ["grove_map_rows", "grove_map_chunks", "grove_map_heads", "grove_map_manifests", "grove_value_nodes"]) same(driver.execute(`SELECT COUNT(*) n FROM ${table}`, [])[0]?.n, 0)
}

// mvccLifetimes preserves held descendants across native acknowledgement, collection and rollback (mvcc.test.ts; workerd/mvcc.workers.ts).
export function mvccLifetimes(driver: SyncSqlite, text: string, cacheBytes: number, chunkBytes: number) {
  const config = { scope: "mvcc-lifetimes", cacheBytes, chunkBytes, rowBatchItems: 2, maxParameters: 5 }, store = makeSync(driver, config), peer = makeSync(driver, config), holder = {}
  const initial = store.bind(State).initial({ anchor: { text, items: [] } }), extra = { text: "界🙂" + text, items: [text] }
  const publish = (document: { readonly reference: ValueReference<unknown> }) => store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: store.owner("head"), document }] }))
  publish(initial)
  const parent = initial.set(["parent"], extra)
  let child = parent
  store.transaction(tx => {
    store.commit(tx, { publish: [{ owner: "head", expected: initial.reference, document: parent }] })
    child = parent.set(["child"], extra); store.hold(holder, "draft", child.reference)
  })
  publish(store.bind(State).initial({ replacement: extra }))
  store.discard(); peer.collect()
  same(child.read([]), { anchor: { text, items: [] }, parent: extra, child: extra })
  publish(child); store.release(holder); store.discard(); peer.collect()
  let rolled = child
  try {
    store.transaction(tx => {
      const parent = child.set(["rollback-parent"], extra)
      store.commit(tx, { publish: [{ owner: "head", expected: child.reference, document: parent }] })
      rolled = parent.set(["rollback-child"], extra); store.hold(holder, "rolled", rolled.reference)
      throw new Error("Injected MVCC rollback")
    })
    throw new Error("Missing rollback")
  } catch (cause) { if (!(cause instanceof Error) || cause.message !== "Injected MVCC rollback") throw cause }
  store.discard(); peer.collect(); publish(rolled)
  same(peer.view(rolled.reference, State).materialize(), { anchor: { text, items: [] }, parent: extra, child: extra, "rollback-parent": extra, "rollback-child": extra })
  store.release(holder)
  store.transaction(tx => store.commit(tx, { release: [{ owner: "head", expected: rolled.reference }] }))
  store.discard(); peer.collect()
  same(driver.execute("SELECT COUNT(*) n FROM grove_map_rows", [])[0]?.n, 0)
}

// mvccChurn removes overwritten rows and obsolete base-branch tombstones while preserving pinned snapshots (mvcc.test.ts; workerd/mvcc.workers.ts).
export function mvccChurn(driver: SyncSqlite, count: number, text: string) {
  const store = makeSync(driver, { scope: "mvcc-churn", cacheBytes: 8192 }), schema = keyValue(Schema.String)
  let document = store.bind(schema).initial({ anchor: text, changed: "first" })
  const publish = () => store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: store.owner("head"), document }] }))
  publish()
  const first = document.reference
  store.transaction(tx => store.commit(tx, { retain: [{ owner: "first", selection: first }] }))
  for (let index = 0; index < count; index++) {
    document = document.set(["changed"], String(index)).set([`temporary-${index}`], text).remove([`temporary-${index}`])
    publish()
  }
  store.collect()
  same(store.view(first, schema).materialize(), { anchor: text, changed: "first" })
  same(document.read([]), { anchor: text, changed: String(count - 1) })
  same(driver.execute("SELECT COUNT(*) n FROM grove_map_rows", [])[0]?.n, 3)
  store.transaction(tx => store.commit(tx, { release: [{ owner: "first", expected: first }] }))
  store.collect()
  same(driver.execute("SELECT COUNT(*) n FROM grove_map_rows", [])[0]?.n, 2)
  document = document.remove(["changed"]); publish(); store.collect()
  same(document.read([]), { anchor: text })
  same(driver.execute("SELECT COUNT(*) n FROM grove_map_rows", [])[0]?.n, 1)
}

// mvccReplay preserves version identities when a different fork wins placement and old manifests are collected (mvcc.test.ts; workerd/mvcc.workers.ts).
export function mvccReplay(driver: SyncSqlite, text: string) {
  const store = makeSync(driver, { scope: "mvcc-replay", cacheBytes: 0 }), schema = keyValue(Schema.String), base = store.bind(schema).initial({ anchor: text })
  store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: null, document: base }], retain: [{ owner: "base", selection: base.reference }] }))
  const first = base.set(["key"], "A:" + text), expected = encodeReference(first.reference), rival = base.set(["key"], "B:" + text)
  store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: base.reference, document: rival }] }))
  store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: rival.reference, document: first }] }))
  store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: first.reference, document: base }] }))
  store.discard(); store.collect()
  const replay = store.bind(schema).open(base.reference).set(["key"], "A:" + text)
  same(encodeReference(replay.reference), expected)
  store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: base.reference, document: replay }] }))
  same(replay.read([]), { anchor: text, key: "A:" + text })
}

// mvccCorruption rejects missing revisions and malformed chunks before consumer schema decoding (mvcc.test.ts; workerd/mvcc.workers.ts).
export function mvccCorruption(driver: SyncSqlite, text: string, chunkBytes: number, mode: "row" | "chunk" | "length") {
  const store = makeSync(driver, { scope: "mvcc-corruption", cacheBytes: 0, chunkBytes }), schema = keyValue(Schema.String), value = "界🙂\uFEFF\uFFFE".repeat(10) + text
  const document = store.bind(schema).initial({ key: value })
  store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: null, document }] }))
  same(document.read(["key"]), value)
  if (mode === "row") driver.execute("DELETE FROM grove_map_rows", [])
  else if (mode === "chunk") driver.execute("DELETE FROM grove_map_chunks WHERE ordinal=0", [])
  else driver.execute("UPDATE grove_map_rows SET metadata=json_set(metadata,'$[1]',json_extract(metadata,'$[1]')+1)", [])
  store.clear()
  try { document.read(["key"]) } catch { return }
  throw new Error("Corrupt key-value revision was accepted")
}


// mvccForkChurn removes transient fork keys while retaining deletion markers that hide inherited values (mvcc.test.ts; workerd/mvcc.workers.ts).
export function mvccForkChurn(driver: SyncSqlite, count: number, text: string) {
  const store = makeSync(driver, { scope: "mvcc-fork-churn", cacheBytes: 128 }), schema = keyValue(Schema.String), base = store.bind(schema).initial({ anchor: text, deleted: "old" })
  let document = base
  const publish = () => store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: store.owner("head"), document }] }))
  publish(); document = base.set(["deleted"], "rival"); publish(); document = base.remove(["deleted"]); publish()
  for (let index = 0; index < count; index++) { document = document.set([`temporary-${index}`], text).remove([`temporary-${index}`]); publish() }
  store.discard(); store.collect()
  same(document.read([]), { anchor: text })
  same(driver.execute("SELECT COUNT(*) n FROM grove_map_rows", [])[0]?.n, 3)
  document = store.bind(schema).initial({ anchor: text }); publish(); store.collect()
  same(driver.execute("SELECT COUNT(*) n FROM grove_map_rows", [])[0]?.n, 1)
}
