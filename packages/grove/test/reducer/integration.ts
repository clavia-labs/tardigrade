import { isDeepStrictEqual } from "node:util"
import { makeLegacySync } from "../../src/storage/sqlite/store"
import { Schema } from "effect"
import { appendOnly, keyValue, tree } from "../../src/schema"
import { makeSync, type SyncSqlite } from "../../src/sqlite"
import * as migrations from "../../src/migrations"
import { encodeReference, decodeReference } from "../../src/value"

const Message = Schema.Struct({ text: Schema.String }), Job = Schema.Struct({ text: Schema.String })
const Legacy = Schema.Struct({ messages: appendOnly(Schema.Array(Message)), jobs: keyValue(Job), status: tree(Schema.String) })
const State = Schema.Struct({ messages: Schema.Array(Message), jobs: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })), status: Schema.String })
const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message) }
const equal = isDeepStrictEqual

// migrationHistory preserves old inputs while state changes format, including failed mixed commits and reclamation.
export function migrationHistory(driver: SyncSqlite, texts: readonly string[], fail: boolean) {
  const config = { scope: "migration", cacheBytes: 0, chunkBytes: 1024 }
  let store = makeLegacySync(driver, config)
  const old = store.bind(Legacy).initial({ messages: texts.map(text => ({ text })), jobs: { first: { text: texts[0] ?? "" } }, status: "before" })
  const oldRef = old.reference, input = old.selectEach(["messages"], ["text"])
  const inputRef = store.reference(input), inputText = encodeReference(inputRef), oldText = JSON.stringify({ type: "Legacy", texts })
  store.transaction(tx => {
    tx.execute("CREATE TABLE event_log(seq INTEGER PRIMARY KEY,event TEXT NOT NULL)", [])
    tx.execute("INSERT INTO event_log VALUES(0,?)", [oldText])
    store.commit(tx, { publish: [{ owner: "state", expected: null, document: old }], retain: [{ owner: "effect", selection: input }] })
  })
  store.discard()
  store = makeSync(driver, config)
  const definition = {
    schema: State,
    migrate: (raw: unknown) => {
      const value = Schema.decodeUnknownSync(Legacy)(raw)
      return { ...value, jobs: Object.entries(value.jobs).map(([id, job]) => ({ id, ...job })) }
    },
    reduce: (state: typeof State.Type, text: string) => ({ ...state, status: "after", messages: [{ text }, ...state.messages] }),
  }
  const bound = store.materialize(definition)
  const restore = (stored: unknown) => migrations.open(stored, {
    initial: bound.initial, reference: reference => bound.open(decodeReference(reference)),
    decode: Schema.decodeUnknownSync(State, { onExcessProperty: "error" }), migrate: definition.migrate,
  })
  const source = { messages: texts.map(text => ({ text })), jobs: { first: { text: texts[0] ?? "" } }, status: "before" }
  const restored = restore({ _tag: "DocumentState", reference: encodeReference(store.owner("state")!) })
  assert(equal(restore(source).value, restored.value), "plain checkpoint shares migration entrypoint")
  assert(equal(restore({ _tag: "ValueState", value: source }).value, restored.value), "whole-value checkpoint shares migration entrypoint")
  assert(equal(migrations.read({ _tag: "DocumentState", reference: inputText }, reference => store.readValue(decodeReference(reference))), texts), "reading retained input preserves its selected version")
  assert(equal(restored.value, { messages: texts.map(text => ({ text })), jobs: [{ id: "first", text: texts[0] ?? "" }], status: "before" }), "legacy state migration")
  const next = restored.apply("new", null, 1), nextRef = next.reference
  const publish = () => store.transaction(tx => {
    tx.execute("INSERT INTO event_log VALUES(1,?)", [JSON.stringify({ type: "New" })])
    store.commit(tx, { publish: [{ owner: "state", expected: oldRef, document: nextRef }] })
  })
  if (fail) {
    let failed = false
    try { store.transaction(tx => { publish(); store.commit(tx, { release: [{ owner: "effect", expected: inputRef }] }); store.collect(); throw new Error("Injected rollback") }) }
    catch { failed = true }
    assert(failed, "rollback injection")
    assert(encodeReference(store.owner("state")!) === encodeReference(oldRef), "state publication rolled back")
    assert(equal(store.readValue(inputRef), texts), "old input survives failed mixed collection")
    assert(driver.execute("SELECT 1 FROM event_log WHERE seq=1", []).length === 0, "event publication rolled back")
  }
  publish(); store.discard(); store.collect()
  assert(equal(store.readValue(decodeReference(inputText)), texts), "old input remains readable")
  assert(JSON.parse(encodeReference(nextRef)).scope === `${config.scope}/pages`, "new reference format")
  assert(equal(restore({ _tag: "DocumentState", reference: encodeReference(nextRef) }).value, next.value), "current references bypass legacy shape migration")
  assert(driver.execute("SELECT event FROM event_log WHERE seq=0", [])[0]?.event === oldText, "immutable log is unchanged")
  store = makeSync(driver, config)
  const current = store.materialize(definition).open(store.owner("state")!).value
  assert(equal(current, next.value), "new state survives cold open")
  let invalidState = false
  try { store.materialize(definition).initial({ ...current, unexpected: texts }) } catch { invalidState = true }
  assert(invalidState, "strict state validation survives migration")
  const forged = JSON.parse(encodeReference(nextRef)) as { selection: { root: string } }
  forged.selection.root = forged.selection.root.slice(0, -1) + (forged.selection.root.endsWith("1") ? "2" : "1")
  let invalidReference = false
  try { store.readValue(decodeReference(JSON.stringify(forged))) } catch { invalidReference = true }
  assert(invalidReference, "corrupt reducer reference cannot alias a retained version")
  assert(equal(store.readValue(inputRef), texts), "old input survives cold open")
  store.transaction(tx => store.commit(tx, { release: [{ owner: "effect", expected: inputRef }] })); store.collect()
  assert(driver.execute("SELECT 1 FROM grove_value_nodes LIMIT 1", []).length === 0, "legacy materialisations reclaimed after release")
  assert(equal(store.readValue(store.owner("state")!), next.value), "new state survives legacy reclamation")
  return { oldInputStable: true, coldRestore: true, rollback: fail, logUnchanged: true, legacyReclaimed: true, messages: current.messages.length }
}
