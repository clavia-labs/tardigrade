import assert from "node:assert/strict"
import fc from "fast-check"
import { Schema } from "effect"
import { tree, appendOnly, keyValue, encodeReference, type MerkleTree, type ValueReference } from "@tardie/grove"
import { makeSync, type SyncSqlite } from "@tardie/grove/sqlite"
import { initialState, reduceJson, type Event, type State } from "../model"

export const collectionShapes = ["tree", "append-only", "key-value", "mixed"] as const
type Shape = typeof collectionShapes[number]
const event = fc.record({ key: fc.oneof(fc.string(), fc.constantFrom("__proto__", "constructor", "2", "1", "界")), text: fc.string(), remove: fc.boolean(), delta: fc.integer({ min: -10, max: 10 }), rollback: fc.boolean() })
export const historyCases = fc.record({ events: fc.array(event, { minLength: 2, maxLength: 12 }), checkpoint: fc.nat(), cacheBytes: fc.constantFrom(0, 256, 8192), chunkBytes: fc.constantFrom(1, 17, 4096) })
type Case = typeof historyCases extends fc.Arbitrary<infer Value> ? Value : never
const Document = Schema.Struct({ count: Schema.Int }), Messages = Schema.Array(Schema.String), Job = Schema.Struct({ text: Schema.String })
const jsonState = Schema.Struct({ document: Document, messages: Messages, jobs: Schema.Record(Schema.String, Job) })
const schemaFor = (shape: Shape): Schema.Decoder<State> => shape === "tree" ? tree(jsonState) : Schema.Struct({ document: tree(Document), messages: shape === "append-only" || shape === "mixed" ? appendOnly(Messages) : tree(Messages), jobs: shape === "key-value" || shape === "mixed" ? keyValue(Job) : tree(Schema.Record(Schema.String, Job)) })
const same = (actual: State, expected: State) => { assert.deepEqual(actual, expected); assert.equal(JSON.stringify(actual), JSON.stringify(expected)) }

const apply = (document: MerkleTree<State>, event: Event) => document.batch(edit => {
  edit.set(["document", "count"], document.read(["document", "count"]) + event.delta)
  edit.append(["messages"], [event.text])
  if (event.remove) edit.remove(["jobs", event.key])
  else edit.set(["jobs", event.key], { text: event.text })
})

// materialisationHistory checks prefix safety, retry progress and eventual reclamation after every owner is released (../properties.ts).
export function materialisationHistory(driver: SyncSqlite, shape: Shape, options: Case) {
  const schema = schemaFor(shape), config = { scope: "history", cacheBytes: options.cacheBytes, chunkBytes: options.chunkBytes, objectPageItems: 2, pageItems: 2, fanout: 3, leafBytes: 64, tailBytes: 32 }
  const open = () => makeSync(driver, config)
  driver.execute("CREATE TABLE history(position INTEGER PRIMARY KEY,event TEXT NOT NULL)", [])
  let store = open(), model = initialState(), document = store.bind(schema).initial(model)
  const versions: { readonly reference: ValueReference; readonly state: State }[] = [{ reference: document.reference, state: model }]
  store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: null, document }], retain: [{ owner: "prefix/0", selection: document.reference }] }))
  for (const [index, event] of options.events.entries()) {
    const before = store.owner("head")!, nextModel = reduceJson(model, event)
    const publish = (next: MerkleTree<State>, fail: boolean) => store.transaction(tx => {
      store.commit(tx, { publish: [{ owner: "head", expected: before, document: next }], retain: [{ owner: `prefix/${index + 1}`, selection: next.reference }] })
      tx.execute("INSERT INTO history VALUES(?,?)", [index, JSON.stringify(event)])
      if (fail) throw new Error("Injected history rollback")
    })
    if (event.rollback) {
      assert.throws(() => publish(apply(document, event), true), /Injected history rollback/)
      assert.equal(encodeReference(store.owner("head")!), encodeReference(before))
      assert.equal(driver.execute("SELECT position FROM history", []).length, index)
      store.discard(); store = open(); store.collect()
      document = store.bind(schema).open(store.owner("head")!)
      same(document.read([]), model)
    }
    document = apply(document, event)
    publish(document, false)
    model = nextModel
    versions.push({ reference: document.reference, state: model })
    store.discard(); store = open(); store.collect()
    document = store.bind(schema).open(store.owner("head")!)
    same(document.read([]), model)
    for (const version of versions) same(store.view(version.reference, schema).materialize(), version.state)
    assert.deepEqual(driver.execute("SELECT event FROM history ORDER BY position", []).map(row => String(row.event)), options.events.slice(0, index + 1).map(value => JSON.stringify(value)))
  }
  const cut = options.checkpoint % (options.events.length + 1)
  const recovered = driver.execute("SELECT event FROM history ORDER BY position", []).map(row => JSON.parse(String(row.event)) as Event)
  let replay = store.bind(schema).initial(initialState()), restored = store.bind(schema).initial(store.view(versions[cut]!.reference, schema).materialize())
  for (const event of recovered) replay = apply(replay, event)
  for (const event of recovered.slice(cut)) restored = apply(restored, event)
  same(replay.read([]), model)
  same(restored.read([]), model)
  store.discard()
  store.transaction(tx => store.commit(tx, { release: [{ owner: "head", expected: store.owner("head")! }, ...versions.map((version, index) => ({ owner: `prefix/${index}`, expected: version.reference }))] }))
  store.collect(); store = open(); store.collect()
  for (const table of ["grove_value_nodes", "grove_value_chunks", "grove_value_rows", "grove_value_row_chunks", "grove_map_rows", "grove_map_chunks"]) assert.equal(driver.execute(`SELECT COUNT(*) n FROM ${table}`, [])[0]!.n, 0)
  for (const version of versions) assert.throws(() => store.view(version.reference, schema).materialize())
  assert.equal(driver.execute("SELECT position FROM history", []).length, options.events.length)
}
