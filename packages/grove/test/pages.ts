import assert from "node:assert/strict"
import { Schema } from "effect"
import fc from "fast-check"
import { tree, encodeReference, type Json, type ValueReference } from "@tardie/grove"
import { makeSync, type SyncSqlite } from "@tardie/grove/sqlite"
import { makeLegacySync } from "../src/storage/sqlite/store"

export const pageCases = fc.record({ texts: fc.array(fc.string(), { minLength: 1, maxLength: 30 }), capacity: fc.integer({ min: 4, max: 10 }), cacheBytes: fc.constantFrom(0, 256, 8192), chunkBytes: fc.constantFrom(1, 3, 32, 4096) })
const State = Schema.Struct({ messages: Schema.Array(Schema.String), count: Schema.Int })
const initial = { messages: [] as readonly string[], count: 0 }

// pageHistory compares both authoring paths across native rollback, retained versions and reopen (pages.test.ts; workerd/pages.workers.ts).
export function pageHistory(driver: SyncSqlite, options: typeof pageCases extends fc.Arbitrary<infer Case> ? Case : never) {
  const config = { ...options, scope: "pages", dirtyBytes: 1024 * 1024 }, open = () => makeSync(driver, config)
  const plainHolder = {}
  let store = open(), document = store.bind(State).initial(initial)
  let plain = store.materialize({ schema: State, reduce: (state: typeof initial, text: string) => ({ messages: [...state.messages, text], count: state.count + 1 }) }).initial(initial)
  const plainStore = store
  const pinned: { ref: ValueReference<unknown>; value: Json }[] = []
  store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: null, document }] }))
  for (const [index, text] of options.texts.entries()) {
    const before = store.owner("head"), next = document.append(["messages"], [text]).set(["count"], index + 1)
    plain = plain.apply(text, undefined, index)
    plainStore.hold(plainHolder, "plain", plain.reference)
    assert.deepEqual(next.read([]), plain.value)
    assert.throws(() => store.transaction(tx => { store.commit(tx, { publish: [{ owner: "head", expected: before, document: next }] }); throw new Error("rollback") }), /rollback/)
    assert.equal(encodeReference(store.owner("head")!), encodeReference(before!))
    store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: before, document: next }], retain: [{ owner: `input/${index}`, selection: next.select(["messages"]) }] }))
    pinned.push({ ref: store.owner(`input/${index}`)!, value: plain.value.messages })
    store.discard(); store = open(); store.collect()
    document = store.bind(State).open(store.owner("head")!)
    assert.deepEqual(document.read([]), plain.value)
    for (const pin of pinned) assert.deepEqual(store.view(pin.ref, Schema.Array(Schema.String)).materialize(), pin.value)
  }
  plainStore.release(plainHolder); plainStore.discard()
  for (const [index, pin] of pinned.entries()) store.transaction(tx => store.commit(tx, { release: [{ owner: `input/${index}`, expected: pin.ref }] }))
  store.transaction(tx => store.commit(tx, { release: [{ owner: "head", expected: document.reference }] }))
  store.discard(); store.collect()
  assert.equal(driver.execute("SELECT COUNT(*) AS n FROM grove_pages", [])[0]!.n, 0)
  assert.equal(driver.execute("SELECT COUNT(*) AS n FROM grove_page_chunks", [])[0]!.n, 0)
}

// pageUpgrade retains legacy selected inputs while replacement heads use page storage (pages.test.ts; workerd/pages.workers.ts).
export function pageUpgrade(driver: SyncSqlite, text: string, reducer: boolean) {
  const scope = "upgrade", legacy = makeLegacySync(driver, { scope, cacheBytes: 0 })
  const value: typeof State.Type = { messages: [text], count: 1 }
  const collection = legacy.bind(tree(State)).initial(value)
  const old = reducer ? legacy.materialize({ schema: State, reduce: (state: typeof value) => state }).initial(value) : collection
  const selected = reducer ? old.reference : legacy.reference(collection.select(["messages"]))
  legacy.transaction(tx => legacy.commit(tx, { publish: [{ owner: "head", expected: null, document: old.reference }], retain: [{ owner: "pending", selection: selected }] }))
  const store = makeSync(driver, { scope, cacheBytes: 0 }), next = store.bind(State).open(old.reference).append(["messages"], ["next"])
  store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: old.reference, document: next }] }))
  store.discard(); store.collect()
  const reopened = makeSync(driver, { scope, cacheBytes: 0 })
  assert.deepEqual(reopened.bind(State).open(reopened.owner("head")!).read([]), { messages: [text, "next"], count: 1 })
  assert.deepEqual(reopened.readValue(selected), reducer ? value : [text])
  reopened.transaction(tx => reopened.commit(tx, { release: [{ owner: "pending", expected: selected }] }))
  reopened.collect()
  assert.throws(() => reopened.readValue(selected))
}

// pageHolders protects peer-held descendants and expires read leases after rollback (pages.test.ts; workerd/pages.workers.ts).
export function pageHolders(driver: SyncSqlite) {
  const store = makeSync(driver, { scope: "holders", cacheBytes: 0 }), peer = makeSync(driver, { scope: "holders", cacheBytes: 0 }), holder = {}
  let document = store.bind(State).initial({ messages: ["界🙂\uFEFF\uFFFE"], count: 0 })
  store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: null, document }] }))
  const child = document.append(["messages"], ["child"])
  store.hold(holder, "child", child.reference)
  document = document.set(["count"], 1)
  store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: store.owner("head"), document }] }))
  store.discard(); peer.collect()
  assert.deepEqual(child.read(["messages"]), ["界🙂\uFEFF\uFFFE", "child"])
  const ordered = store.bind(Schema.Struct({ z: Schema.optionalKey(Schema.Int), a: Schema.Int })).initial({ z: 1, a: 2 }).remove(["z"]).set(["z"], 3)
  store.transaction(tx => store.commit(tx, { retain: [{ owner: "ordered", selection: ordered.reference }] }))
  assert.equal(JSON.stringify(peer.readValue(ordered.reference)), '{"a":2,"z":3}')
  store.transaction(tx => store.commit(tx, { release: [{ owner: "ordered", expected: ordered.reference }] }))
  let iterator: IterableIterator<string> | undefined
  const ref = document.reference
  assert.throws(() => store.transaction(() => { iterator = store.view(ref, State).scan(["messages"]); assert.equal(iterator.next().value, "界🙂\uFEFF\uFFFE"); throw new Error("rollback") }), /rollback/)
  assert.throws(() => iterator!.next(), /expired/)
  let rolled = child
  assert.throws(() => store.transaction(tx => {
    const parent = document.append(["messages"], ["tentative parent".repeat(100)]).set(["count"], 2)
    store.commit(tx, { publish: [{ owner: "head", expected: ref, document: parent }] })
    rolled = parent.append(["messages"], ["after tentative persistence"])
    store.hold(holder, "rolled", rolled.reference)
    throw new Error("rollback")
  }), /rollback/)
  store.discard(); peer.collect()
  assert.deepEqual(rolled.read([]), { messages: ["界🙂\uFEFF\uFFFE", "tentative parent".repeat(100), "after tentative persistence"], count: 2 })
  store.transaction(tx => store.commit(tx, { retain: [{ owner: "rolled", selection: rolled.reference }] }))
  assert.deepEqual(peer.readValue(rolled.reference), rolled.read([]))
  store.transaction(tx => store.commit(tx, { release: [{ owner: "rolled", expected: rolled.reference }] }))
  store.release(holder); store.discard(); peer.collect()
  store.transaction(tx => store.commit(tx, { release: [{ owner: "head", expected: ref }] }))
  store.discard(); peer.collect()
}

// pageDetached rebuilds independent JSON after its source pages have been reclaimed (pages.test.ts; workerd/pages.workers.ts).
export function pageDetached(driver: SyncSqlite) {
  const store = makeSync(driver, { scope: "detached", cacheBytes: 0 })
  const define = () => store.materialize({ schema: State, reduce: (state: typeof State.Type) => state })
  const source = define().initial({ messages: ["detached"], count: 1 })
  store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: null, document: source.reference }] }))
  store.discard()
  const copy = define().open(source.reference).value
  store.transaction(tx => store.commit(tx, { release: [{ owner: "head", expected: source.reference }] }))
  store.collect()
  const rebuilt = define().initial(copy)
  store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: null, document: rebuilt.reference }] }))
  assert.deepEqual(makeSync(driver, { scope: "detached", cacheBytes: 0 }).readValue(rebuilt.reference), copy)
}

// pageAppendWork preserves page sharing when pure JSON crosses a persistence boundary (pages.test.ts; workerd/pages.workers.ts).
export function pageAppendWork(driver: SyncSqlite) {
  const store = makeSync(driver, { scope: "append-work", cacheBytes: 0 })
  const schema = Schema.Struct({ messages: Schema.Array(Schema.Struct({ text: Schema.String })) })
  const bound = store.materialize({ schema, reduce: (state: typeof schema.Type) => ({ messages: [...state.messages, { text: "next" }] }) })
  const initial = bound.initial({ messages: Array.from({ length: 1000 }, (_, index) => ({ text: `message ${index}` })) })
  store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: null, document: initial.reference }] }))
  const before = store.stats().pages
  const next = initial.apply(undefined, undefined, 1)
  store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: initial.reference, document: next.reference }] }))
  const after = store.stats().pages
  assert.equal(after.reads, before.reads, "warm reconciliation reloaded persisted navigation pages")
  assert(after.writes - before.writes < 12, "append rewrote unchanged document pages")
  assert(after.writtenBytes - before.writtenBytes < 12000, "append rewrote unchanged payloads")
  assert.deepEqual(makeSync(driver, { scope: "append-work", cacheBytes: 0 }).readValue(next.reference), next.value)
}
