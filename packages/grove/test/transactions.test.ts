import * as Grove from "@tardie/grove"
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { decodeNodeChunks } from "../src/storage/sqlite/chunks"
import { referenceLocator } from "../src/value"
import fc from "fast-check"
import { decodeReference, encodeReference, type ValueReference } from "@tardie/grove"
import { makeSync, type SyncSqlite, type Transaction } from "@tardie/grove/sqlite"

const Message = Schema.Struct({ text: Schema.String })
const State = Schema.Struct({ messages: Schema.Array(Message), status: Schema.String })
const optionsArb = fc.record({ chunkBytes: fc.integer({ min: 1, max: 256 }), maxParameters: fc.integer({ min: 5, max: 12 }), cacheBytes: fc.constantFrom(0, 256, 8192), pageItems: fc.integer({ min: 2, max: 8 }) })
const valueArb = fc.record({ messages: fc.array(fc.record({ text: fc.string() }), { minLength: 2, maxLength: 15 }), status: fc.string() })
const fixture = (options: { chunkBytes: number; maxParameters: number; cacheBytes: number; pageItems: number }) => {
  const db = new Database(":memory:")
  const driver: SyncSqlite = { identity: db, execute: (statement, parameters) => db.query<Record<string, unknown>, (typeof parameters)[number][]>(statement).all(...parameters), transaction: work => db.transaction(work)() }
  const config = { ...options, scope: "documents", leafBytes: 64, tailBytes: 32 }
  return { db, driver, config, store: makeSync(driver, config) }
}

test("transaction sequences match a JSON owner model through rollback, collection and reopen", () => {
  const command = fc.record({ action: fc.constantFrom("append", "set", "rollback", "retain", "collect", "reopen"), text: fc.string(), slot: fc.nat(3) })
  fc.assert(fc.property(optionsArb, valueArb, fc.array(command, { minLength: 10, maxLength: 40 }), (options, initial, commands) => {
    const { db, driver, config, store: first } = fixture(options)
    try {
      db.exec("CREATE TABLE journal(id INTEGER PRIMARY KEY)")
      let store = first, model = structuredClone(initial), accepted = 0
      const retained = new Map<string, { reference: ValueReference; value: typeof initial }>()
      const document = store.bind(State).initial(initial)
      store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: null, document }] }))
      for (const command of commands) {
        const previous = store.owner("head")!
        if (command.action === "append" || command.action === "set" || command.action === "rollback") {
          const draft = command.action === "set" ? store.bind(State).open(previous).set(["status"], command.text) : store.bind(State).open(previous).append(["messages"], [{ text: command.text }])
          const next = command.action === "set" ? { ...model, status: command.text } : { ...model, messages: [...model.messages, { text: command.text }] }
          const write = () => store.transaction(tx => {
            store.commit(tx, { publish: [{ owner: "head", expected: previous, document: draft }] })
            tx.execute("INSERT INTO journal VALUES(?)", [accepted])
            if (command.action === "rollback") throw new Error("Injected rollback")
          })
          if (command.action === "rollback") {
            expect(write).toThrow("Injected rollback")
            expect(encodeReference(store.owner("head")!)).toBe(encodeReference(previous))
            expect(store.stats().stagedNodes).toBeGreaterThan(0)
          } else { write(); model = next; accepted++ }
          store.discard()
        } else if (command.action === "retain") {
          const name = `input/${command.slot}`, old = retained.get(name)
          if (old) { store.transaction(tx => store.commit(tx, { release: [{ owner: name, expected: old.reference }] })); retained.delete(name) }
          else { store.transaction(tx => store.commit(tx, { retain: [{ owner: name, selection: previous }] })); retained.set(name, { reference: previous, value: structuredClone(model) }) }
        } else if (command.action === "collect") store.collect()
        else store = makeSync(driver, config)
        expect(store.view(store.owner("head")!, State).materialize()).toEqual(model)
        for (const [name, retainedValue] of retained) {
          expect(encodeReference(store.owner(name)!)).toBe(encodeReference(retainedValue.reference))
          expect(store.view(retainedValue.reference, State).materialize()).toEqual(retainedValue.value)
        }
        expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM journal").get()!.n).toBe(accepted)
        expect(store.stats().cachedBytes).toBeLessThanOrEqual(options.cacheBytes)
      }
      const head = store.owner("head")!
      store.transaction(tx => store.commit(tx, { release: [{ owner: "head", expected: head }, ...[...retained].map(([owner, entry]) => ({ owner, expected: entry.reference }))] }))
      store.discard(); store.collect()
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM grove_value_nodes").get()!.n).toBe(0)
    } finally { db.close() }
  }), { includeErrorInReport: true, numRuns: 80 })
}, 30000)

test("failed native commits and nested failures preserve staged data and invalidate capabilities", () => {
  fc.assert(fc.property(optionsArb, valueArb, fc.integer({ min: 1, max: 100000 }), (options, value, missingParent) => {
    const { db, store } = fixture(options), foreign = fixture(options)
    try {
      db.exec("PRAGMA foreign_keys=ON; CREATE TABLE parents(id INTEGER PRIMARY KEY); CREATE TABLE children(parent INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED)")
      const document = store.bind(State).initial(value)
      let escaped: Transaction | undefined
      expect(() => store.transaction(tx => {
        escaped = tx
        store.commit(tx, { publish: [{ owner: "head", expected: null, document }] })
        tx.execute("INSERT INTO children VALUES(?)", [missingParent])
      })).toThrow()
      expect(store.owner("head")).toBeNull()
      expect(store.stats().stagedNodes).toBeGreaterThan(0)
      expect(db.query("SELECT * FROM children").all()).toEqual([])
      expect(() => escaped!.execute("SELECT 1", [])).toThrow("expired")
      expect(() => store.commit(escaped!, {})).toThrow("expired")
      store.transaction(tx => expect(() => foreign.store.commit(tx, {})).toThrow("another connection"))
      expect(() => store.transaction(() => Promise.resolve())).toThrow("synchronous")
      expect(() => store.transaction(tx => {
        store.commit(tx, { publish: [{ owner: "head", expected: null, document }] })
        try { store.transaction(() => { throw new Error("Nested failure") }) } catch { /* Outer transaction must reject. */ }
      })).toThrow("Nested failure")
      expect(store.owner("head")).toBeNull()
      store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: null, document }] }))
      expect(store.view(store.owner("head")!, State).materialize()).toEqual(value)
      expect(store.stats().stagedNodes).toBe(0)
    } finally { db.close(); foreign.db.close() }
  }), { includeErrorInReport: true, numRuns: 80 })
})

test("lease lifetimes protect released versions and expire on transaction rollback", () => {
  fc.assert(fc.property(optionsArb, valueArb, fc.boolean(), (options, value, rollback) => {
    const { db, driver, config, store } = fixture(options)
    try {
      const document = store.bind(State).initial(value), ref = store.reference(document.select(["messages"]))
      let iterator: IterableIterator<typeof Message.Type> | undefined
      const start = () => store.transaction(tx => {
        store.commit(tx, { retain: [{ owner: "input", selection: ref }] })
        iterator = store.view(ref, Schema.Array(Message)).scan([])
        expect(iterator.next().value).toEqual(value.messages[0]!)
        if (rollback) throw new Error("reader rollback")
      })
      if (rollback) {
        expect(start).toThrow("reader rollback")
        expect(store.stats().activeLeases).toBe(0)
        expect(() => iterator!.next()).toThrow("lease expired")
        iterator!.return?.()
      } else {
        start()
        const view = store.view(ref, Schema.Array(Message)), unused = view.scan([])
        expect(store.stats().activeLeases).toBe(1)
        unused.return?.()
        store.transaction(tx => store.commit(tx, { release: [{ owner: "input", expected: ref }] }))
        const other = makeSync(driver, config)
        other.collect()
        expect(view.materialize()).toEqual(value.messages)
        iterator!.return?.()
        expect(store.stats().activeLeases).toBe(0)
        other.collect()
        expect(() => view.materialize()).toThrow("persisted backing")
      }
    } finally { db.close() }
  }), { includeErrorInReport: true, numRuns: 80 })
})

test("Unicode chunking is bounded, authenticates mutations and reads legacy binary payloads", () => {
  const unicode = fc.array(fc.integer({ min: 0, max: 65535 }), { maxLength: 100 }).map(codes => String.fromCharCode(...codes))
  fc.assert(fc.property(optionsArb, unicode, fc.nat(), (options, text, offset) => {
    const { db, driver, config, store } = fixture(options)
    try {
      const value = { messages: [{ text: 'é😀漢字\\"\n' + text }], status: text }
      const document = store.bind(State).initial(value)
      store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: null, document }] }))
      const rows = db.query<{ hash: string; ordinal: number; payload: string | Uint8Array; bytes: number }, []>("SELECT hash,ordinal,payload,length(CAST(payload AS BLOB)) AS bytes FROM grove_value_chunks").all()
      for (const row of rows) {
        expect(row.bytes).toBeLessThanOrEqual(options.chunkBytes)
        if (options.chunkBytes < 4) expect(typeof row.payload).not.toBe("string")
        else if (typeof row.payload !== "string") expect(["\ufeff", "\ufffe"]).toContain(new TextDecoder("utf-8", { ignoreBOM: true }).decode(row.payload)[0]!)
      }
      const reopen = () => { const other = makeSync(driver, config); return other.view(other.owner("head")!, State).materialize() }
      expect(reopen()).toEqual(value)
      for (const row of rows) if (typeof row.payload === "string") db.query("UPDATE grove_value_chunks SET payload=? WHERE hash=? AND ordinal=?").run(new TextEncoder().encode(row.payload), row.hash, row.ordinal)
      expect(reopen()).toEqual(value)
      const row = rows[offset % rows.length]!
      db.query("UPDATE grove_value_chunks SET payload=? WHERE hash=? AND ordinal=?").run(new Uint8Array(), row.hash, row.ordinal)
      expect(reopen).toThrow()
      const bytes = new TextEncoder().encode(JSON.stringify(text)), split = offset % (bytes.length + 1)
      expect(decodeNodeChunks([{ inline: bytes.buffer, ordinal: null, payload: null, byte_length: bytes.length, chunk_count: 1 }])).toBe(JSON.stringify(text))
      expect(decodeNodeChunks([bytes.slice(0, split), bytes.slice(split)].map((payload, ordinal) => ({ inline: null, ordinal, payload: payload.buffer, byte_length: bytes.length, chunk_count: 2 })))).toBe(JSON.stringify(text))
    } finally { db.close() }
  }), { includeErrorInReport: true, numRuns: 150, examples: [[{ chunkBytes: 4, maxParameters: 5, cacheBytes: 0, pageItems: 2 }, "\ufffe", 0], [{ chunkBytes: 4, maxParameters: 5, cacheBytes: 0, pageItems: 2 }, "\ufeff", 0], [{ chunkBytes: 4, maxParameters: 5, cacheBytes: 0, pageItems: 2 }, "x\ufeff\ufeffhi😀\ufeff".repeat(20), 0], [{ chunkBytes: 1, maxParameters: 5, cacheBytes: 0, pageItems: 2 }, "é😀", 0], [{ chunkBytes: 3, maxParameters: 5, cacheBytes: 0, pageItems: 2 }, "😀", 0], [{ chunkBytes: 4, maxParameters: 5, cacheBytes: 0, pageItems: 2 }, "é😀漢字", 0]] })
})

test("scope, ownership and immutable-byte checks reject generated invalid publications atomically", () => {
  fc.assert(fc.property(optionsArb, valueArb, fc.string({ minLength: 1 }), (options, value, suffix) => {
    const { db, driver, config, store } = fixture(options)
    try {
      const document = store.bind(State).initial(value), ref = document.reference
      const other = makeSync(driver, { ...config, scope: "foreign" + suffix })
      expect(() => other.transaction(tx => other.commit(tx, { retain: [{ owner: "input", selection: ref }] }))).toThrow("scope mismatch")
      expect(() => other.hold({}, "foreign", ref)).toThrow("scope mismatch")
      expect(other.stats().localHolders).toBe(0)
      expect(() => other.transaction(tx => other.commit(tx, { publish: [{ owner: "head", expected: null, document }] }))).toThrow("another Grove instance")
      expect(() => store.transaction(tx => store.commit(tx, { retain: [{ owner: "duplicate", selection: ref }, { owner: "duplicate", selection: ref }] }))).toThrow("Duplicate")
      const selected = store.reference(document.select(["messages"]))
      expect(() => store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: null, document: selected }] }))).toThrow("whole-document")
      const wire = JSON.parse(encodeReference(ref)), missing = decodeReference(JSON.stringify({ ...wire, selection: { ...wire.selection, root: "0".repeat(64) } }))
      expect(() => store.transaction(tx => store.commit(tx, { retain: [{ owner: "missing", selection: missing }] }))).toThrow("missing root")
      const owner = "\u{1F332}/" + suffix
      store.transaction(tx => store.commit(tx, { publish: [{ owner, expected: null, document }] }))
      expect(store.owners("\u{1F332}/").map(entry => entry.name)).toEqual([owner])
      const current = store.owner(owner)!
      const changed = store.bind(State).open(current).set(["status"], value.status + "changed")
      store.transaction(tx => store.commit(tx, { publish: [{ owner, expected: current, document: changed }] }))
      expect(() => store.transaction(tx => store.commit(tx, { publish: [{ owner, expected: current, document }] }))).toThrow("owner changed")
      const draft = store.bind(State).initial(value)
      expect(db.query("UPDATE grove_value_chunks SET payload=? WHERE hash=? AND ordinal=0").run("corrupt", referenceLocator(draft.reference, "documents").root).changes).toBe(1)
      expect(() => store.transaction(tx => store.commit(tx, { retain: [{ owner: "copy", selection: draft.select([]) }] }))).toThrow()
      expect(store.owner("copy")).toBeNull()
    } finally { db.close() }
  }), { includeErrorInReport: true, numRuns: 80 })
})

test("release and collection roll back atomically with generated application failures", () => {
  fc.assert(fc.property(optionsArb, valueArb, fc.string({ minLength: 1 }), (options, value, failure) => {
    const { db, driver, config, store } = fixture(options)
    try {
      db.exec("CREATE TABLE completions(id TEXT PRIMARY KEY)")
      const document = store.bind(State).initial(value), input = store.reference(document.select(["messages"]))
      store.transaction(tx => store.commit(tx, { retain: [{ owner: "request", selection: input }] }))
      expect(() => store.transaction(tx => {
        store.commit(tx, { release: [{ owner: "request", expected: input }] })
        store.collect()
        tx.execute("INSERT INTO completions VALUES(?)", [failure])
        throw new Error(failure)
      })).toThrow(failure)
      expect(db.query("SELECT * FROM completions").all()).toEqual([])
      expect(encodeReference(store.owner("request")!)).toBe(encodeReference(input))
      expect(makeSync(driver, config).view(input, Schema.Array(Message)).materialize()).toEqual(value.messages)
      const view = store.view(input, Schema.Array(Message)), unused = view.scan([])
      expect(store.stats().activeLeases).toBe(0)
      unused.return?.()
      expect(() => store.view(input, Schema.Array(Schema.Int)).scan([]).next()).toThrow()
      expect(() => { for (const _ of view.scan([])) throw new Error(failure) }).toThrow(failure)
      expect(store.stats().activeLeases).toBe(0)
      store.transaction(tx => { store.commit(tx, { release: [{ owner: "request", expected: input }] }); tx.execute("INSERT INTO completions VALUES(?)", [failure]) })
      store.collect()
      expect(() => view.materialize()).toThrow("persisted backing")
    } finally { db.close() }
  }), { numRuns: 80, includeErrorInReport: true })
})


test("local holders protect published and draft dependencies across connection handles", () => {
  const command = fc.record({ action: fc.constantFrom("hold", "replace", "release", "collect", "reopen"), holder: fc.nat(2), slot: fc.nat(2), text: fc.string() })
  fc.assert(fc.property(optionsArb, valueArb, fc.array(command, { minLength: 10, maxLength: 40 }), (options, initial, commands) => {
    const { db, driver, config, store } = fixture(options)
    try {
      const documents = store.bind(State), source = documents.initial(initial), sourceHolder = {}
      store.transaction(tx => store.commit(tx, { publish: [{ owner: "head", expected: null, document: source }] }))
      store.hold(sourceHolder, "source", source.reference!)
      store.transaction(tx => store.commit(tx, { release: [{ owner: "head", expected: source.reference! }] }))
      const holders = [{}, {}, {}]
      const model = new Map<object, Map<string, { document: typeof source; value: typeof initial }>>()
      let peer = makeSync(driver, config)
      for (const command of commands) {
        const holder = holders[command.holder]!, name = String(command.slot)
        if (command.action === "hold" || command.action === "replace") {
          const value = { ...initial, status: command.text }
          const draft = source.set(["status"], command.text)
          store.hold(holder, name, draft.reference!)
          let owned = model.get(holder)
          if (!owned) { owned = new Map(); model.set(holder, owned) }
          owned.set(name, { document: draft, value })
          store.discard()
          expect(draft.read([])).toEqual(value)
        } else if (command.action === "release") { store.release(holder); model.delete(holder) }
        else if (command.action === "reopen") peer = makeSync(driver, config)
        else peer.collect()
        peer.collect()
        expect(source.read([])).toEqual(initial)
        expect(peer.view(source.reference!, State).materialize()).toEqual(initial)
        for (const owned of model.values()) for (const { document, value } of owned.values()) expect(document.read([])).toEqual(value)
        expect(store.stats().localHolders).toBe(model.size + 1)
      }
      for (const holder of [sourceHolder, ...holders]) store.release(holder)
      store.discard(); peer.collect()
      expect(store.stats()).toMatchObject({ localHolders: 0, heldReferences: 0, stagedNodes: 0 })
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM grove_value_nodes").get()!.n).toBe(0)
    } finally { db.close() }
  }), { includeErrorInReport: true, numRuns: 80 })
}, 30000)

test("owner group replacement is isolated, transactional and survives reopening", () => {
  fc.assert(fc.property(optionsArb, fc.array(valueArb, { minLength: 2, maxLength: 5 }), fc.nat(), (options, values, offset) => {
    const { db, driver, config, store } = fixture(options)
    try {
      const documents = values.map(value => store.bind(State).initial(value))
      const references = documents.map(document => document.reference!)
      const split = offset % references.length
      store.transaction(tx => {
        store.replaceOwners(tx, "inputs/", references)
        store.replaceOwners(tx, "peer/", [references[0]!])
      })
      const before = store.owners("inputs/").map(owner => encodeReference(owner.reference))
      expect(() => store.transaction(tx => {
        store.replaceOwners(tx, "inputs/", references.slice(split))
        throw new Error("Injected owner rollback")
      })).toThrow("rollback")
      expect(store.owners("inputs/").map(owner => encodeReference(owner.reference))).toEqual(before)
      store.transaction(tx => store.replaceOwners(tx, "inputs/", references.slice(split)))
      const reopened = makeSync(driver, config)
      reopened.collect()
      expect(reopened.owners("inputs/").map(owner => reopened.view(owner.reference, State).materialize())).toEqual(values.slice(split))
      expect(reopened.owners("peer/").map(owner => reopened.view(owner.reference, State).materialize())).toEqual([values[0]!])
      reopened.transaction(tx => { reopened.replaceOwners(tx, "inputs/", []); reopened.replaceOwners(tx, "peer/", []) })
      reopened.collect()
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM grove_value_nodes").get()!.n).toBe(0)
    } finally { db.close() }
  }), { includeErrorInReport: true, numRuns: 80 })
}, 30000)

test("independent stores transfer JSON through values and preserve idempotent native commits", () => {
  fc.assert(fc.property(optionsArb, fc.jsonValue(), (options, raw) => {
    const source = fixture(options), destination = fixture(options)
    try {
      const store = makeSync(destination.driver, { ...destination.config, scope: "destination" })
      const expected = JSON.parse(JSON.stringify({ value: raw, repeated: raw }))
      const reference = source.store.capture(expected)
      source.store.transaction(tx => source.store.commit(tx, { retain: [{ owner: "source", selection: reference }] }))
      source.store.discard()
      expect(() => store.transaction(tx => store.commit(tx, { retain: [{ owner: "copy", selection: reference }] }))).toThrow("scope mismatch")
      const reopened = makeSync(source.driver, source.config)
      const copied = store.capture(reopened.readValue(reopened.owner("source")!))
      store.transaction(tx => store.commit(tx, { retain: [{ owner: "copy", selection: copied }] }))
      expect(store.transaction(tx => store.commit(tx, { retain: [{ owner: "copy", selection: copied }] }))).toEqual({ nodes: 0, bytes: 0, rows: 0 })
      store.discard(); store.collect()
      expect(makeSync(destination.driver, { ...destination.config, scope: "destination" }).readValue(copied)).toEqual(expected)
      expect(destination.db.query("SELECT name FROM sqlite_master WHERE name IN ('grove_nodes','grove_chunks','grove_owners')").all()).toEqual([])
      for (const maxParameters of [3, 4]) expect(() => makeSync(source.driver, { ...source.config, maxParameters })).toThrow("maxParameters")
    } finally { source.db.close(); destination.db.close() }
  }), { numRuns: 80, includeErrorInReport: true })
})

test("native acknowledgement preserves drafts created before and during a committed transaction", () => {
  fc.assert(fc.property(optionsArb, valueArb, fc.string(), (options, value, text) => {
    const { db, store } = fixture(options)
    try {
      const documents = store.bind(State), document = documents.initial(value)
      const unrelated = documents.initial({ ...value, status: `unrelated:${text}` })
      let later: typeof document | undefined
      store.transaction(tx => {
        store.commit(tx, { publish: [{ owner: "head", expected: null, document }] })
        later = document.set(["status"], `later:${text}`)
      })
      expect(store.view(document.reference, State).materialize()).toEqual(value)
      expect(store.stats().stagedNodes).toBeGreaterThan(0)
      expect(store.readValue(unrelated.reference)).toEqual({ ...value, status: `unrelated:${text}` })
      expect(store.readValue(later!.reference)).toEqual({ ...value, status: `later:${text}` })
      store.transaction(tx => store.commit(tx, { retain: [{ owner: "unrelated", selection: unrelated.reference }, { owner: "later", selection: later!.reference }] }))
      store.discard(); store.collect()
      expect(store.view(store.owner("unrelated")!, State).materialize()).toEqual({ ...value, status: `unrelated:${text}` })
      expect(store.view(store.owner("later")!, State).materialize()).toEqual({ ...value, status: `later:${text}` })
    } finally { db.close() }
  }), { numRuns: 80, includeErrorInReport: true })
})

test("discard evicts arbitrary unpublished drafts without reloading committed cache entries", () => {
  fc.assert(fc.property(fc.string(), fc.string(), (committed, unpublished) => {
    fc.pre(committed !== unpublished)
    const stored = new Map<string, string>()
    const grove = Grove.make({ scope: "discard", load: hash => { const text = stored.get(hash); if (text === undefined) throw new Error("Missing node"); return text } })
    const documents = grove.bind(Schema.Struct({ text: Schema.String }))
    const original = documents.initial({ text: committed }), batch = grove.staging.prepare(), nodes = batch.nodes
    for (const [hash, node] of nodes) stored.set(hash, node.text)
    grove.staging.acknowledge(batch)
    expect(original.read([])).toEqual({ text: committed })
    const draft = documents.initial({ text: unpublished })
    expect(draft.read([])).toEqual({ text: unpublished })
    const loaded = grove.stats().loadedNodes
    grove.discard()
    expect(grove.stats().stagedNodes).toBe(0)
    expect(original.read([])).toEqual({ text: committed })
    expect(grove.stats().loadedNodes).toBe(loaded)
    expect(() => draft.read([])).toThrow("Missing node")
    grove.clear()
    expect(original.read([])).toEqual({ text: committed })
    expect(grove.stats().loadedNodes).toBe(loaded + 1)
  }), { includeErrorInReport: true, numRuns: 100 })
})

test("prepared batches preserve unrelated drafts and later entries with identical hashes", () => {
  fc.assert(fc.property(fc.string(), fc.string(), (text, laterText) => {
    const stored = new Map<string, string>()
    const storage = { scope: "staging", options: { cacheBytes: 0 }, load: (hash: string) => {
      const value = stored.get(hash)
      if (value === undefined) throw new Error("Missing node")
      return value
    } }
    const grove = Grove.make(storage), peer = Grove.make(storage)
    const documents = grove.bind(Schema.Struct({ text: Schema.String }))
    const initial = documents.initial({ text: `initial:${text}` })
    const unrelated = documents.initial({ text: `unrelated:${text}` })
    const batch = grove.staging.prepare([initial.reference])
    expect(grove.staging.prepare([unrelated.reference]).nodes.size).toBeGreaterThan(0)
    expect(() => peer.staging.acknowledge(batch)).toThrow("foreign")
    const repeated = documents.initial({ text: `initial:${text}` })
    const later = documents.initial({ text: `later:${laterText}` })
    expect(Grove.encodeReference(repeated.reference)).toBe(Grove.encodeReference(initial.reference))
    for (const [hash, node] of batch.nodes) stored.set(hash, node.text)
    grove.staging.acknowledge(batch)
    expect(() => grove.staging.acknowledge(batch)).toThrow("already acknowledged")
    for (const document of [repeated, unrelated, later]) {
      expect(grove.staging.prepare([document.reference]).nodes.size).toBeGreaterThan(0)
      expect(document.read([])).toEqual(document === repeated ? { text: `initial:${text}` } : document === unrelated ? { text: `unrelated:${text}` } : { text: `later:${laterText}` })
    }
    const final = grove.staging.prepare()
    for (const [hash, node] of final.nodes) stored.set(hash, node.text)
    grove.staging.acknowledge(final)
    expect(grove.stats().stagedNodes).toBe(0)
    expect(peer.bind(Schema.Struct({ text: Schema.String })).open(later.reference).read([])).toEqual({ text: `later:${laterText}` })
  }), { numRuns: 100, includeErrorInReport: true })
})
