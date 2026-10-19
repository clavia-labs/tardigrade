import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import fc from "fast-check"
import { makeSync, DEFAULT_PACK_BYTES, type Grove, type Json, type Reference, type Row, type Sqlite, type Transaction } from "../../src/reducer"
import { freeze, makeReconciler } from "../../src/reducer/json"

const reconcile = makeReconciler(0)

const driver = (db: Database): Sqlite => ({
  identity: db,
  execute: (sql, parameters) => db.query<Row, (typeof parameters)[number][]>(sql).all(...parameters),
  transaction: work => db.transaction(work)(),
})
const json = (grove: Grove, name = "state") => grove.materialize<Json, Json, unknown>({ name, schema: Schema.Json, input: Schema.Json, initial: null, reduce: (_, event) => event })
const count = (db: Database, table: string) => db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM grove_state_${table === "pins" ? "gc_pins" : table}`).get()!.n
const equalJson = (a: unknown, b: unknown) => expect(JSON.stringify(a)).toBe(JSON.stringify(b))
const jsonValues = fc.jsonValue().map(value => freeze(value))

test("ordinary reducers preserve array edits, keyed edits, metadata and sequence through cold replay", () => {
  const State = Schema.Struct({ count: Schema.Int, messages: Schema.Array(Schema.String), jobs: Schema.Record(Schema.String, Schema.Int) })
  const Event = Schema.Struct({ type: Schema.Literals(["insert", "edit", "drop", "job", "removeJob", "noop"]), index: Schema.Int, key: Schema.String, text: Schema.String })
  const event = fc.record({ type: fc.constantFrom("insert", "edit", "drop", "job", "removeJob", "noop"), index: fc.integer({ min: 0, max: 1000 }), key: fc.constantFrom("a", "__proto__", "0", "", "\u{1f422}"), text: fc.string({ maxLength: 100 }) })
  const reduce = (state: typeof State.Type, event: typeof Event.Type, metadata: { increment: number }, sequence: number): typeof State.Type => {
    if (event.type === "noop") return state
    const index = event.index % (state.messages.length + 1)
    const messages = event.type === "insert" ? [...state.messages.slice(0, index), event.text, ...state.messages.slice(index)]
      : event.type === "edit" ? state.messages.map((text, i) => i === index ? event.text : text)
      : event.type === "drop" ? state.messages.filter((_, i) => i !== index) : state.messages
    const jobs = event.type === "job" ? { ...state.jobs, [event.key]: sequence }
      : event.type === "removeJob" ? Object.fromEntries(Object.entries(state.jobs).filter(([key]) => key !== event.key)) : state.jobs
    return { count: state.count + metadata.increment, messages, jobs }
  }
  fc.assert(fc.property(fc.array(event, { minLength: 1, maxLength: 50 }), events => {
    const db = new Database(":memory:")
    try {
      const sqlite = driver(db), grove = makeSync(sqlite, { scope: "edits" })
      const definition = { name: "state", schema: State, input: Event, initial: { count: 0, messages: [], jobs: {} }, reduce }
      const state = grove.materialize(definition)
      let current = state.initial(), oracle: typeof State.Type = current.value
      for (const [i, event] of events.entries()) {
        const record = { sequence: 2 * i, event, metadata: { increment: 3 } }
        const invalidEvent = { ...event, unexpected: true }
        expect(() => state.apply(current, { ...record, event: invalidEvent })).toThrow()
        oracle = reduce(oracle, event, record.metadata, record.sequence)
        const head = state.head(), next = state.apply(current, record)
        grove.transaction(tx => state.publish(tx, next, { expected: head?.reference ?? null }))
        current = next; grove.discard(); grove.collect()
        const cold = makeSync(sqlite, { scope: "edits" }).materialize(definition).head()!
        expect(cold.value).toEqual(oracle)
        expect(cold.sequence).toBe(record.sequence)
      }
      expect(count(db, "history")).toBe(0)
    } finally { db.close() }
  }), { numRuns: 100, seed: 20261019, includeErrorInReport: true })
})

test("incremental rows equal a plain fold through commits, collection and cold restore", () => {
  fc.assert(fc.property(fc.array(fc.tuple(jsonValues, fc.boolean()), { minLength: 1, maxLength: 20 }), events => {
    const db = new Database(":memory:")
    try {
      const sqlite = driver(db), grove = makeSync(sqlite, { scope: "fold" }), state = json(grove)
      db.exec("CREATE TABLE events(seq INTEGER PRIMARY KEY,event TEXT NOT NULL)")
      let current = state.initial()
      const retained: { reference: Reference; value: Json; owner: string }[] = []
      for (const [i, [event, keep]] of events.entries()) {
        const head = state.head(), next = state.apply(current, { sequence: i, event, metadata: null })
        if (i % 3 === 0) grove.collect()
        grove.transaction(tx => {
          tx.execute("INSERT INTO events VALUES(?,?)", [i, JSON.stringify(event)])
          state.publish(tx, next, { expected: head?.reference ?? null })
          if (keep) { const owner = `input/${i}`; grove.retain(tx, owner, next.reference); retained.push({ reference: next.reference, value: next.value, owner }) }
        })
        current = next; grove.discard(); grove.collect()
        equalJson(state.head()!.value, event)
        equalJson(makeSync(sqlite, { scope: "fold" }).materialize({ name: "state", schema: Schema.Json, input: Schema.Json, initial: null, reduce: (_, value) => value }).head()!.value, event)
        for (const previous of retained) equalJson(state.open(previous.reference).value, previous.value)
      }
      grove.transaction(tx => { for (const previous of retained) grove.release(tx, previous.owner, { expected: previous.reference }) })
      grove.collect()
      expect(count(db, "history")).toBe(0)
      expect(count(db, "versions")).toBe(1)
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM events").get()!.n).toBe(events.length)
    } finally { db.close() }
  }), { numRuns: 100, seed: 20261019, includeErrorInReport: true })
})

test("shared subtrees stay shared and local edits change only their path", () => {
  fc.assert(fc.property(jsonValues, fc.integer(), (subtree, number) => {
    const before = freeze({ subtree, number: 0 }) as { readonly subtree: Json; readonly number: number }
    const after = freeze({ ...before, number: number || 1 }) as typeof before
    expect(after.subtree).toBe(before.subtree)
    const changes = reconcile(before, after)
    expect([...changes.keys()]).toEqual(['["number"]'])
    const rows = new Map([...reconcile(undefined, before)].filter((entry): entry is [string, NonNullable<typeof entry[1]>] => entry[1] !== null))
    for (const [path, row] of changes) { if (row) rows.set(path, row); else rows.delete(path) }
    equalJson(reconcile.restore(rows), after)
  }), { numRuns: 200, seed: 20261019, includeErrorInReport: true })
})

test("retention preserves old inputs and release makes their history reclaimable", () => {
  fc.assert(fc.property(fc.integer({ min: 3, max: 30 }), steps => {
    const db = new Database(":memory:")
    try {
      const grove = makeSync(driver(db), { scope: "retention" }), state = json(grove)
      let current = state.initial(), retained: Reference | undefined
      for (let i = 0; i < steps; i++) {
        const head = state.head(), next = state.apply(current, { sequence: i, event: { count: i }, metadata: null })
        grove.transaction(tx => {
          state.publish(tx, next, { expected: head?.reference ?? null })
          if (i === 1) { retained = next.reference; grove.retain(tx, "effect", retained) }
        })
        current = next; grove.discard(); grove.collect()
        expect(count(db, "current")).toBe(1)
      }
      expect(state.open(retained!).value).toEqual({ count: 1 })
      expect(count(db, "history")).toBe(1)
      grove.transaction(tx => grove.release(tx, "effect", { expected: retained! }))
      grove.collect()
      expect(count(db, "history")).toBe(0)
      expect(count(db, "versions")).toBe(1)
      expect(() => state.open(retained!)).toThrow("expired")
    } finally { db.close() }
  }), { numRuns: 40, includeErrorInReport: true })
})

test("failed transactions roll back events, state, ownership and observed head caches", () => {
  fc.assert(fc.property(jsonValues, jsonValues, (first, second) => {
    const db = new Database(":memory:")
    try {
      db.exec("CREATE TABLE events(seq INTEGER PRIMARY KEY,event TEXT)")
      const sqlite = driver(db), grove = makeSync(sqlite, { scope: "atomic" }), peer = makeSync(sqlite, { scope: "atomic" }), state = json(grove), other = json(peer)
      const a = state.apply(state.initial(), { sequence: 0, event: first, metadata: null })
      grove.transaction(tx => state.publish(tx, a, { expected: null }))
      const b = state.apply(a, { sequence: 1, event: second, metadata: null })
      expect(() => grove.transaction(tx => {
        tx.execute("INSERT INTO events VALUES(1,?)", [JSON.stringify(second)])
        state.publish(tx, b, { expected: a.reference })
        grove.retain(tx, "pending", b.reference)
        equalJson(other.head()!.value, second)
        throw new Error("Injected crash")
      })).toThrow("Injected crash")
      expect(state.head()!.reference).toBe(a.reference)
      expect(other.head()!.reference).toBe(a.reference)
      expect(count(db, "owners")).toBe(0)
      expect(db.query("SELECT * FROM events").all()).toEqual([])
      grove.transaction(tx => state.publish(tx, b, { expected: a.reference }))
      equalJson(other.head()!.value, second)
    } finally { db.close() }
  }), { numRuns: 100, seed: 20261019, includeErrorInReport: true })
})

test("staged forks survive peer collection and cannot overwrite a stale head", () => {
  fc.assert(fc.property(jsonValues, jsonValues, (left, right) => {
    const db = new Database(":memory:")
    try {
      const sqlite = driver(db), a = makeSync(sqlite, { scope: "fork" }), b = makeSync(sqlite, { scope: "fork" }), aa = json(a), bb = json(b)
      const base = aa.apply(aa.initial(), { sequence: 0, event: { initial: true }, metadata: null })
      a.transaction(tx => aa.publish(tx, base, { expected: null })); a.discard()
      const first = aa.apply(base, { sequence: 1, event: left, metadata: null })
      const second = bb.apply(bb.open(base.reference), { sequence: 2, event: right, metadata: null })
      a.transaction(tx => aa.publish(tx, first, { expected: base.reference })); a.discard(); a.collect()
      expect(() => b.transaction(tx => bb.publish(tx, second, { expected: base.reference }))).toThrow("head changed")
      b.transaction(tx => bb.publish(tx, second, { expected: first.reference }))
      b.discard(); b.collect()
      const cold = json(makeSync(sqlite, { scope: "fork" }))
      equalJson(cold.head()!.value, right)
      expect(count(db, "documents")).toBe(1)
      expect(count(db, "versions")).toBe(1)
    } finally { db.close() }
  }), { numRuns: 100, seed: 20261019, includeErrorInReport: true })
})

test("nested failures poison the outer transaction and transaction tokens expire", () => {
  const db = new Database(":memory:")
  try {
    const grove = makeSync(driver(db), { scope: "tokens" }), state = json(grove), next = state.initial()
    let expired: Transaction | undefined
    expect(() => grove.transaction(tx => {
      expired = tx
      state.publish(tx, next, { expected: null })
      try { grove.transaction(() => { throw new Error("Nested failure") }) } catch { /* The outer transaction must still roll back. */ }
    })).toThrow("Nested failure")
    expect(state.head()).toBeNull()
    expect(() => expired!.execute("SELECT 1", [])).toThrow("expired")
    expect(() => grove.transaction(() => Promise.resolve(1))).toThrow("synchronous")
    expect(() => grove.transaction(tx => { try { tx.execute("INVALID SQL", []) } catch { /* The transaction stays failed. */ } })).toThrow()
  } finally { db.close() }
})

test("TEXT chunks preserve JSON across Unicode boundaries and retained versions", () => {
  fc.assert(fc.property(fc.array(fc.constantFrom("\ufeff", "\ufffe", "\u{1f600}", "\ud800", "\udc00", "\n", "\u0000", "\"", "\\"), { minLength: 2, maxLength: 100 }), fc.integer({ min: 5, max: 128 }), (points, chunkBytes) => {
    const db = new Database(":memory:")
    try {
      const sqlite = driver(db), grove = makeSync(sqlite, { scope: "unicode", chunkBytes }), state = json(grove), value = points.join("")
      const first = state.apply(state.initial(), { sequence: 0, event: value, metadata: null })
      grove.transaction(tx => { state.publish(tx, first, { expected: null }); grove.retain(tx, "input", first.reference) })
      const next = state.apply(first, { sequence: 1, event: "replacement", metadata: null })
      grove.transaction(tx => state.publish(tx, next, { expected: first.reference }))
      grove.discard(); grove.collect()
      const cold = json(makeSync(sqlite, { scope: "unicode", chunkBytes }))
      expect(cold.open(first.reference).value).toBe(value)
      expect(cold.head()!.value).toBe("replacement")
      expect(db.query<{ n: number | null }, []>("SELECT MAX(length(CAST(payload AS BLOB))) n FROM grove_state_chunks").get()!.n ?? 0).toBeLessThanOrEqual(chunkBytes)
      for (const invalid of [0, 1, 4, NaN, Infinity]) expect(() => makeSync(sqlite, { scope: "invalid", chunkBytes: invalid })).toThrow("chunkBytes")
    } finally { db.close() }
  }), { numRuns: 100, seed: 20261019, includeErrorInReport: true })
})

test("schemas, sequence order, JSON ownership and scope are enforced", () => {
  const db = new Database(":memory:")
  try {
    const grove = makeSync(driver(db), { scope: "checks" })
    const state = grove.materialize({ name: "count", schema: Schema.Struct({ count: Schema.Int }), input: Schema.Int, initial: { count: 0 }, reduce: (previous, count) => ({ ...previous, count }) })
    const a = state.initial(), b = state.apply(a, { sequence: 1, event: 1, metadata: null })
    expect(Object.isFrozen(b.value)).toBe(true)
    expect(() => Object.defineProperty(b.value, "count", { value: 8 })).toThrow()
    expect(() => state.apply(b, { sequence: 1, event: 2, metadata: null })).toThrow("advance")
    expect(() => state.apply(b, { sequence: 2, event: 0.5, metadata: null })).toThrow()
    grove.transaction(tx => state.publish(tx, b, { expected: null }))
    const foreign = makeSync(driver(db), { scope: "other" }).materialize({ name: "count", schema: Schema.Struct({ count: Schema.Int }), input: Schema.Int, initial: { count: 0 }, reduce: (_, count) => ({ count }) })
    expect(() => foreign.open(b.reference)).toThrow("missing")
    expect(() => foreign.apply(b, { sequence: 2, event: 2, metadata: null })).toThrow("Foreign")
    const cycle: { loop?: unknown } = {}; cycle.loop = cycle
    const holes: unknown[] = []; holes.length = 2
    for (const invalid of [cycle, new Date(), undefined, Infinity, { bad: undefined }, holes, { get bad() { return 1 } }]) expect(() => freeze(invalid)).toThrow()
  } finally { db.close() }
})

test("a live JSON value can seed a new branch after its unretained reference expires", () => {
  fc.assert(fc.property(jsonValues, jsonValues, (first, second) => {
    const db = new Database(":memory:")
    try {
      const grove = makeSync(driver(db), { scope: "expired" }), state = json(grove)
      const old = state.apply(state.initial(), { sequence: 0, event: first, metadata: null })
      grove.transaction(tx => state.publish(tx, old, { expected: null }))
      const head = state.apply(old, { sequence: 1, event: second, metadata: null })
      grove.transaction(tx => state.publish(tx, head, { expected: old.reference }))
      grove.discard(); grove.collect()
      expect(() => state.open(old.reference)).toThrow("expired")
      const branch = state.apply(old, { sequence: 2, event: first, metadata: null })
      grove.transaction(tx => state.publish(tx, branch, { expected: head.reference }))
      grove.discard(); grove.collect()
      equalJson(state.head()!.value, first)
    } finally { db.close() }
  }), { numRuns: 100, seed: 20261019, includeErrorInReport: true })
})

test("packing matches UTF-8 JSON size and preserves array structure", () => {
  const scalar = fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.array(fc.constantFrom("a", "é", "\u{1f422}", "\ud800", "\n", "\"", "\\"), { maxLength: 30 }).map(parts => parts.join("")))
  const objects = fc.dictionary(fc.string({ maxLength: 12 }), fc.oneof(scalar, fc.dictionary(fc.string({ maxLength: 8 }), scalar)))
  fc.assert(fc.property(objects, fc.integer({ min: 0, max: 512 }), (input, packBytes) => {
    const db = new Database(":memory:")
    try {
      const sqlite = driver(db), grove = makeSync(sqlite, { scope: "packing", packBytes }), state = json(grove)
      const next = state.apply(state.initial(), { sequence: 0, event: freeze(input), metadata: null })
      grove.transaction(tx => state.publish(tx, next, { expected: null }))
      const root = db.query<{ kind: string }, []>("SELECT kind FROM grove_state_current WHERE path='[]'").get()!
      expect(root.kind).toBe(Buffer.byteLength(JSON.stringify(input)) <= packBytes ? "value" : "object")
      equalJson(json(makeSync(sqlite, { scope: "packing", packBytes: packBytes + 1 })).head()!.value, input)
      const arrays = state.apply(next, { sequence: 1, event: { nested: { messages: [{ text: "hello" }] } }, metadata: null })
      grove.transaction(tx => state.publish(tx, arrays, { expected: next.reference }))
      expect(db.query<{ kind: string }, []>(`SELECT kind FROM grove_state_current WHERE path='["nested","messages"]'`).get()!.kind).toBe("array")
      expect(count(db, "current")).toBeGreaterThanOrEqual(4)
    } finally { db.close() }
  }), { numRuns: 200, seed: 20261019, includeErrorInReport: true })
})

test("crossing the packing boundary preserves retained snapshots and removes obsolete paths", () => {
  fc.assert(fc.property(fc.integer({ min: 32, max: 1024 }), packBytes => {
    const db = new Database(":memory:")
    try {
      const sqlite = driver(db), grove = makeSync(sqlite, { scope: "boundary", packBytes }), state = json(grove)
      const small = state.apply(state.initial(), { sequence: 0, event: { text: "a" }, metadata: null })
      grove.transaction(tx => { state.publish(tx, small, { expected: null }); grove.retain(tx, "small", small.reference) })
      const large = state.apply(small, { sequence: 1, event: { text: "x".repeat(packBytes), count: 1 }, metadata: null })
      grove.transaction(tx => { state.publish(tx, large, { expected: small.reference }); grove.retain(tx, "large", large.reference) })
      expect(count(db, "current")).toBe(3)
      const packed = state.apply(large, { sequence: 2, event: { text: "b" }, metadata: null })
      grove.transaction(tx => state.publish(tx, packed, { expected: large.reference }))
      grove.discard(); grove.collect()
      expect(count(db, "current")).toBe(1)
      const cold = json(makeSync(sqlite, { scope: "boundary" }))
      expect(cold.open(small.reference).value).toEqual(small.value)
      expect(cold.open(large.reference).value).toEqual(large.value)
      expect(cold.head()!.value).toEqual(packed.value)
      grove.transaction(tx => { grove.release(tx, "small", { expected: small.reference }); grove.release(tx, "large", { expected: large.reference }) })
      grove.collect()
      expect(count(db, "history")).toBe(0)
      expect(count(db, "chunks")).toBe(0)
    } finally { db.close() }
  }), { numRuns: 100, seed: 20261019, includeErrorInReport: true })
})

test("changing the packing budget forks layout while retaining old inputs", () => {
  fc.assert(fc.property(fc.constantFrom(0, 32, 128, DEFAULT_PACK_BYTES), fc.constantFrom(0, 32, 128, DEFAULT_PACK_BYTES), (beforeBytes, afterBytes) => {
    const db = new Database(":memory:")
    try {
      const sqlite = driver(db), a = makeSync(sqlite, { scope: "tune", packBytes: beforeBytes }), aa = json(a)
      const first = aa.apply(aa.initial(), { sequence: 0, event: { text: "x".repeat(64) }, metadata: null })
      a.transaction(tx => { aa.publish(tx, first, { expected: null }); a.retain(tx, "input", first.reference) }); a.discard()
      const b = makeSync(sqlite, { scope: "tune", packBytes: afterBytes }), bb = json(b)
      const next = bb.apply(bb.head()!, { sequence: 1, event: { text: "second" }, metadata: null })
      b.transaction(tx => bb.publish(tx, next, { expected: first.reference })); b.discard(); b.collect()
      const cold = json(makeSync(sqlite, { scope: "tune" }))
      expect(cold.head()!.value).toEqual(next.value)
      expect(cold.open(first.reference).value).toEqual(first.value)
      b.transaction(tx => b.release(tx, "input", { expected: first.reference })); b.collect()
      expect(count(db, "documents")).toBe(1)
      expect(count(db, "history")).toBe(0)
      for (const invalid of [-1, 0.5, NaN, Infinity]) expect(() => makeSync(sqlite, { scope: "invalid", packBytes: invalid })).toThrow("packBytes")
    } finally { db.close() }
  }), { numRuns: 80, seed: 20261019, includeErrorInReport: true })
})

test("fresh equal packed objects produce no row changes and appends preserve existing messages", () => {
  fc.assert(fc.property(fc.array(fc.string({ maxLength: 100 }), { minLength: 1, maxLength: 30 }), texts => {
    const compare = makeReconciler(), before = freeze({ messages: texts.map(text => ({ role: "user", text })) })
    expect(compare(before, freeze(JSON.parse(JSON.stringify(before)))).size).toBe(0)
    const next = freeze({ messages: [...(before as { readonly messages: readonly Json[] }).messages, { role: "assistant", text: "next" }] })
    const edits = compare(before, next)
    expect(edits.size).toBe(4)
    expect([...edits.values()].filter(cell => cell?.kind === "entry")).toHaveLength(2)
    const db = new Database(":memory:")
    try {
      const grove = makeSync(driver(db), { scope: "messages" }), state = json(grove)
      const a = state.apply(state.initial(), { sequence: 0, event: before, metadata: null })
      grove.transaction(tx => state.publish(tx, a, { expected: null }))
      expect(count(db, "current")).toBe(2 + 2 * texts.length)
      const b = state.apply(a, { sequence: 1, event: next, metadata: null })
      grove.transaction(tx => state.publish(tx, b, { expected: a.reference }))
      expect(count(db, "current")).toBe(4 + 2 * texts.length)
    } finally { db.close() }
  }), { numRuns: 100, seed: 20261019, includeErrorInReport: true })
})

test("unobserved replay coalesces into a single materialisation while preserving every event", () => {
  fc.assert(fc.property(fc.array(jsonValues, { minLength: 2, maxLength: 40 }), fc.constantFrom(0, 64, DEFAULT_PACK_BYTES), (events, packBytes) => {
    const db = new Database(":memory:")
    try {
      const sqlite = driver(db), grove = makeSync(sqlite, { scope: "batch", packBytes }), state = json(grove)
      db.exec("CREATE TABLE events(seq INTEGER PRIMARY KEY,event TEXT NOT NULL)")
      let current = state.initial()
      for (const [sequence, event] of events.entries()) current = state.apply(current, { sequence, event, metadata: null })
      grove.transaction(tx => {
        for (const [sequence, event] of events.entries()) tx.execute("INSERT INTO events VALUES(?,?)", [sequence, JSON.stringify(event)])
        state.publish(tx, current, { expected: null })
      })
      expect(count(db, "versions")).toBe(1)
      expect(count(db, "history")).toBe(0)
      expect(count(db, "current")).toBe(makeReconciler(packBytes)(undefined, current.value).size)
      const recovered = json(makeSync(sqlite, { scope: "batch" })).head()!
      equalJson(recovered.value, events.at(-1))
      expect(recovered.sequence).toBe(events.length - 1)
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM events").get()!.n).toBe(events.length)
    } finally { db.close() }
  }), { numRuns: 100, seed: 20261019, includeErrorInReport: true })
})

test("a batch overwrites each changed path once from its committed base", () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 1000 }), steps => {
    const db = new Database(":memory:")
    try {
      const sqlite = driver(db)
      let writes = 0
      const grove = makeSync({ ...sqlite, execute: (sql, parameters) => { if (sql.startsWith("INSERT INTO grove_state_current")) writes++; return sqlite.execute(sql, parameters) } }, { scope: "overwrite" }), state = json(grove)
      const base = state.apply(state.initial(), { sequence: 0, event: { count: 0 }, metadata: null })
      grove.transaction(tx => state.publish(tx, base, { expected: null })); grove.discard()
      const before = writes
      let current = base
      for (let sequence = 1; sequence <= steps; sequence++) current = state.apply(current, { sequence, event: { count: sequence }, metadata: null })
      grove.transaction(tx => state.publish(tx, current, { expected: base.reference }))
      expect(writes - before).toBe(1)
      expect(count(db, "versions")).toBe(2)
      expect(count(db, "history")).toBe(1)
      expect(json(makeSync(sqlite, { scope: "overwrite" })).head()!.value).toEqual({ count: steps })
    } finally { db.close() }
  }), { numRuns: 50, seed: 20261019, includeErrorInReport: true })
})

test("exposed intermediate references survive coalescing, rollback and cold restore", () => {
  fc.assert(fc.property(fc.array(fc.tuple(jsonValues, fc.boolean()), { minLength: 3, maxLength: 30 }), fc.constantFrom(0, 64, DEFAULT_PACK_BYTES), (events, packBytes) => {
    const db = new Database(":memory:")
    try {
      const sqlite = driver(db), grove = makeSync(sqlite, { scope: "observed", packBytes }), state = json(grove)
      let current = state.initial()
      const inputs: { reference: Reference; value: Json; sequence: number }[] = []
      for (const [sequence, [event, observe]] of events.entries()) {
        current = state.apply(current, { sequence, event, metadata: null })
        if (observe) inputs.push({ reference: current.reference, value: current.value, sequence })
      }
      const publish = (tx: Transaction) => {
        state.publish(tx, current, { expected: null })
        for (const [i, input] of inputs.entries()) grove.retain(tx, `effect/${i}`, input.reference)
      }
      expect(() => grove.transaction(tx => { publish(tx); throw new Error("Injected crash") })).toThrow("Injected crash")
      expect(count(db, "versions")).toBe(0)
      grove.collect()
      grove.transaction(publish); grove.discard(); grove.collect()
      expect(count(db, "versions")).toBe(new Set([...inputs.map(input => input.reference), current.reference]).size)
      const cold = json(makeSync(sqlite, { scope: "observed" }))
      for (const input of inputs) {
        const old = cold.open(input.reference)
        equalJson(old.value, input.value)
        expect(old.sequence).toBe(input.sequence)
      }
      equalJson(cold.head()!.value, events.at(-1)![0])
      grove.transaction(tx => { for (const [i, input] of inputs.entries()) grove.release(tx, `effect/${i}`, { expected: input.reference }) }); grove.collect()
      expect(count(db, "versions")).toBe(1)
    } finally { db.close() }
  }), { numRuns: 100, seed: 20261019, includeErrorInReport: true })
})

test("late first observation captures coalesced JSON without reviving expired exposed references", () => {
  fc.assert(fc.property(fc.array(jsonValues, { minLength: 2, maxLength: 30 }), events => {
    const db = new Database(":memory:")
    try {
      const sqlite = driver(db), grove = makeSync(sqlite, { scope: "late" }), state = json(grove)
      const first = state.apply(state.initial(), { sequence: 0, event: events[0]!, metadata: null })
      let current = first
      for (let sequence = 1; sequence < events.length; sequence++) current = state.apply(current, { sequence, event: events[sequence]!, metadata: null })
      grove.transaction(tx => state.publish(tx, current, { expected: null })); grove.discard(); grove.collect()
      expect(count(db, "versions")).toBe(1)
      const late = first.reference
      grove.transaction(tx => grove.retain(tx, "late", late)); grove.discard(); grove.collect()
      const cold = json(makeSync(sqlite, { scope: "late" }))
      equalJson(cold.open(late).value, events[0])
      expect(cold.open(late).sequence).toBe(0)
      grove.transaction(tx => grove.release(tx, "late", { expected: late })); grove.collect()
      expect(first.reference).toBe(late)
      expect(() => state.open(first.reference)).toThrow("expired")
      expect(() => cold.open(late)).toThrow("expired")
    } finally { db.close() }
  }), { numRuns: 100, seed: 20261019, includeErrorInReport: true })
})

test("staged aliases share observation and commit status", () => {
  const db = new Database(":memory:")
  try {
    const grove = makeSync(driver(db), { scope: "alias" }), state = json(grove)
    const initial = state.apply(state.initial(), { sequence: 0, event: { count: 0 }, metadata: null })
    const alias = state.open(initial.reference)
    grove.transaction(tx => state.publish(tx, alias, { expected: null })); grove.discard()
    const next = state.apply(alias, { sequence: 1, event: { count: 1 }, metadata: null })
    grove.transaction(tx => state.publish(tx, next, { expected: alias.reference }))
    expect(count(db, "documents")).toBe(1)
    expect(state.open(initial.reference).value).toEqual({ count: 0 })
  } finally { db.close() }
})
