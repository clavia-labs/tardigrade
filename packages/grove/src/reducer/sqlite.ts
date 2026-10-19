import { transactions, type Context } from "../storage/transaction"
import { Exit, Schema } from "effect"
import { freeze, makeReconciler, DEFAULT_PACK_BYTES, type Cell } from "./json"
import type { Grove } from "./index"
import type { Definition, Json, Materialization, Reference, Version } from "./state"
import type { Parameter, Row, Sqlite, Transaction } from "./storage"

export const DEFAULT_CHUNK_BYTES = 64 * 1024
export const MIN_CHUNK_BYTES = 5
export interface Options { readonly scope: string; readonly chunkBytes?: number; readonly packBytes?: number }
interface Draft { readonly name: string; readonly version: Version<Json>; readonly parent?: Reference; readonly changes: Map<string, Cell | null> }
interface Identity { readonly reference: string; exposed: boolean; committed: boolean }
interface Saved { readonly reference: string; readonly name: string; readonly document: string; readonly revision: number; readonly sequence: number | null }
interface Participant { readonly scope: string; readonly roots: () => readonly string[] }
interface Connection { readonly participants: Set<WeakRef<Participant>> }
const connections = new WeakMap<object, Connection>()
const name = (value: string) => { if (!value.trim()) throw new Error("Name must be nonempty"); return value }

// makeSync materialises plain reducers over a colocated synchronous SQLite connection (test/reducer/properties.test.ts).
export function makeSync(sqlite: Sqlite, options: Options): Grove {
  const scope = name(options.scope), chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES
  const packBytes = options.packBytes ?? DEFAULT_PACK_BYTES, reconcile = makeReconciler(packBytes)
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < MIN_CHUNK_BYTES) throw new Error(`chunkBytes must be at least ${MIN_CHUNK_BYTES}`)
  let connection = connections.get(sqlite.identity)
  if (!connection) { connection = { participants: new Set() }; connections.set(sqlite.identity, connection) }
  const shared = connection, coordinator = transactions(sqlite)
  let sqlStatements = 0, cellWrites = 0, encodedBytes = 0
  const query = <Result = Row>(sql: string, parameters: readonly Parameter[] = []): readonly Result[] => {
    sqlStatements++
    const result = sqlite.execute(sql, parameters)
    if (!Array.isArray(result)) throw new Error("SQLite must be synchronous")
    return result as readonly Result[]
  }
  if (coordinator.active()) throw new Error("Construct stores outside transactions")
  sqlite.transaction(() => {
    for (const [table, columns] of Object.entries({
      documents: "scope TEXT,document TEXT,revision INTEGER NOT NULL,pack_bytes INTEGER NOT NULL,PRIMARY KEY(scope,document)",
      versions: "scope TEXT,reference TEXT,name TEXT NOT NULL,document TEXT NOT NULL,revision INTEGER NOT NULL,sequence INTEGER,PRIMARY KEY(scope,reference)",
      current: "scope TEXT,document TEXT,path TEXT,since INTEGER NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,chunks INTEGER NOT NULL,PRIMARY KEY(scope,document,path)",
      history: "scope TEXT,document TEXT,path TEXT,since INTEGER,until INTEGER NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,chunks INTEGER NOT NULL,PRIMARY KEY(scope,document,path,since)",
      chunks: "scope TEXT,document TEXT,path TEXT,since INTEGER,ordinal INTEGER,payload TEXT NOT NULL,PRIMARY KEY(scope,document,path,since,ordinal)",
      heads: "scope TEXT,name TEXT,reference TEXT NOT NULL,PRIMARY KEY(scope,name)",
      owners: "scope TEXT,name TEXT,reference TEXT NOT NULL,PRIMARY KEY(scope,name)",
      gc_pins: "scope TEXT,reference TEXT,document TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(scope,reference)",
    })) query(`CREATE TABLE IF NOT EXISTS grove_state_${table}(${columns}) WITHOUT ROWID`)
    query("CREATE INDEX IF NOT EXISTS grove_state_pin_revisions ON grove_state_gc_pins(scope,document,revision)")
  })
  const guard = coordinator.guard, transaction = coordinator.transaction
  const mutate = <Value>(tx: Transaction, work: (context: Context) => Value): Value => {
    const context = guard(tx)
    try { return work(context) } catch (cause) { context.failed = { cause }; throw cause }
  }
  const drafts = new Map<string, Draft>(), names = new Set<string>(), identities = new WeakMap<object, Identity>()
  const participant: Participant = { scope, roots: () => [...drafts.keys(), ...[...drafts.values()].flatMap(draft => draft.parent ? [draft.parent] : [])] }
  shared.participants.add(new WeakRef(participant))
  const saved = (reference: string) => query<Saved>("SELECT reference,name,document,revision,sequence FROM grove_state_versions WHERE scope=? AND reference=?", [scope, reference])[0]
  const head = (materialization: string) => query<{ reference: string }>("SELECT reference FROM grove_state_heads WHERE scope=? AND name=?", [scope, materialization])[0]?.reference ?? null
  const pieces = (text: string): string[] => {
    if (Buffer.byteLength(text) <= chunkBytes) return []
    const result: string[] = []
    let part = "x", bytes = 1
    for (const point of text) {
      const size = Buffer.byteLength(point)
      if (bytes + size > chunkBytes) { result.push(part); part = "x"; bytes = 1 }
      part += point; bytes += size
    }
    result.push(part); return result
  }
  const persist = (reference: string, context: Context): Saved => {
    const existing = saved(reference)
    if (existing) return existing
    const draft = drafts.get(reference)
    if (!draft) throw new Error("Snapshot expired or missing")
    const parent = draft.parent ? saved(draft.parent) ?? (drafts.has(draft.parent) ? persist(draft.parent, context) : undefined) : undefined
    const current = parent && query<{ revision: number; pack_bytes: number }>("SELECT revision,pack_bytes FROM grove_state_documents WHERE scope=? AND document=?", [scope, parent.document])[0]
    const continuing = parent && current?.revision === parent.revision && current.pack_bytes === packBytes
    const document = continuing ? parent.document : crypto.randomUUID(), revision = continuing ? parent.revision + 1 : 0
    for (const [path, cell] of continuing ? draft.changes : reconcile(undefined, draft.version.value)) {
      cellWrites++
      query("INSERT INTO grove_state_history SELECT scope,document,path,since,?,kind,payload,chunks FROM grove_state_current WHERE scope=? AND document=? AND path=?", [revision, scope, document, path])
      if (!cell) { query("DELETE FROM grove_state_current WHERE scope=? AND document=? AND path=?", [scope, document, path]); continue }
      const text = JSON.stringify(cell.value), chunks = pieces(text)
      encodedBytes += Buffer.byteLength(text)
      query("INSERT INTO grove_state_current VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope,document,path) DO UPDATE SET since=excluded.since,kind=excluded.kind,payload=excluded.payload,chunks=excluded.chunks", [scope, document, path, revision, cell.kind, chunks.length ? "" : text, chunks.length])
      for (const [ordinal, payload] of chunks.entries()) query("INSERT INTO grove_state_chunks VALUES(?,?,?,?,?,?)", [scope, document, path, revision, ordinal, payload])
    }
    const row: Saved = { reference, name: draft.name, document, revision, sequence: draft.version.sequence }
    query("INSERT INTO grove_state_documents VALUES(?,?,?,?) ON CONFLICT(scope,document) DO UPDATE SET revision=excluded.revision", [scope, document, revision, packBytes])
    query("INSERT INTO grove_state_versions VALUES(?,?,?,?,?,?)", [scope, reference, draft.name, document, revision, row.sequence])
    context.committed.push(() => { identities.get(draft.version)!.committed = true; drafts.delete(reference) })
    return row
  }
  const materialize = <State extends Json, Event, Metadata>(definition: Definition<State, Event, Metadata>): Materialization<State, Event, Metadata> => {
    const key = name(definition.name)
    if (names.has(key)) throw new Error(`Duplicate materialisation: ${key}`)
    const stateSchema = Schema.toType(definition.schema), eventSchema = Schema.toType(definition.input)
    const stateIs = Schema.decodeUnknownExit(stateSchema, { onExcessProperty: "error" }), eventIs = Schema.decodeExit(eventSchema, { onExcessProperty: "error" })
    const validate = (input: unknown): State => {
      const value = freeze(input)
      if (Exit.isFailure(stateIs(value))) { Schema.decodeUnknownSync(stateSchema, { onExcessProperty: "error" })(value); throw new Error("Invalid state") }
      return value as State
    }
    const owned = new WeakSet<object>()
    let cached: Version<State> | undefined
    const version = (reference: string, value: State, sequence: number | null, identity: Identity = { reference, exposed: false, committed: false }): Version<State> => {
      const result = Object.freeze({ value, sequence, get reference() {
        if (!identity.exposed) {
          identity.exposed = true
          const draft = drafts.get(reference)
          if (draft) identities.get(draft.version)!.exposed = true
          else if (!identity.committed) drafts.set(reference, { name: key, version: result, changes: new Map() })
        }
        return reference as Reference<State>
      } }) as Version<State>
      identities.set(result, identity)
      owned.add(result); return result
    }
    const stage = (value: State, sequence: number | null, previous?: Version<State>) => {
      const source = previous && identities.get(previous)!, pending = source && drafts.get(source.reference)
      const merge = pending && !identities.get(pending.version)!.exposed
      const parent = merge ? pending.parent : source && (pending || source.committed) ? source.reference as Reference : undefined
      let changes = parent ? new Map(reconcile(previous?.value, value)) : new Map<string, Cell | null>()
      if (merge) {
        if (parent) { for (const [path, cell] of changes) pending.changes.set(path, cell); changes = pending.changes }
        drafts.delete(source!.reference)
      }
      const reference = crypto.randomUUID(), result = version(reference, value, sequence)
      drafts.set(reference, { name: key, version: result, ...(parent ? { parent } : {}), changes })
      return result
    }
    const open = (reference: Reference<State>): Version<State> => {
      const draft = drafts.get(reference)
      if (draft) {
        if (draft.name !== key) throw new Error("Foreign materialisation")
        const identity = identities.get(draft.version)!
        identity.exposed = true
        return version(reference, draft.version.value as State, draft.version.sequence, identity)
      }
      const row = saved(reference)
      if (!row) throw new Error("Snapshot expired or missing")
      if (row.name !== key) throw new Error("Foreign materialisation")
      if (cached?.reference === reference) return cached
      const cells = query<{ path: string; since: number; kind: Cell["kind"]; payload: string; chunks: number }>("SELECT path,since,kind,payload,chunks FROM grove_state_current WHERE scope=? AND document=? AND since<=? UNION ALL SELECT path,since,kind,payload,chunks FROM grove_state_history WHERE scope=? AND document=? AND since<=? AND until>?", [scope, row.document, row.revision, scope, row.document, row.revision, row.revision])
      const values = new Map<string, Cell>()
      for (const cell of cells) {
        const chunks = cell.chunks ? query<{ ordinal: number; payload: string }>("SELECT ordinal,payload FROM grove_state_chunks WHERE scope=? AND document=? AND path=? AND since=? ORDER BY ordinal", [scope, row.document, cell.path, cell.since]) : undefined
        if (chunks && (chunks.length !== cell.chunks || chunks.some((part, i) => part.ordinal !== i || !part.payload.startsWith("x")))) throw new Error("Missing snapshot chunks")
        values.set(cell.path, { kind: cell.kind, value: JSON.parse(chunks ? chunks.map(part => part.payload.slice(1)).join("") : cell.payload) as Json })
      }
      return version(reference, validate(reconcile.restore(values)), row.sequence, { reference, exposed: true, committed: true })
    }
    names.add(key)
    return {
      initial: () => stage(validate(structuredClone(definition.initial)), null),
      apply: (previous, record) => {
        if (!owned.has(previous)) throw new Error("Foreign version")
        if (!Number.isSafeInteger(record.sequence) || record.sequence < 0 || previous.sequence !== null && record.sequence <= previous.sequence) throw new Error("Sequence must advance")
        if (Exit.isFailure(eventIs(record.event))) { Schema.decodeSync(eventSchema, { onExcessProperty: "error" })(record.event); throw new Error("Invalid event") }
        return stage(validate(definition.reduce(previous.value, record.event, record.metadata, record.sequence)), record.sequence, previous)
      },
      head: () => {
        const reference = head(key)
        coordinator.active()?.rollback.add(() => { cached = undefined })
        return reference === null ? null : cached = open(reference as Reference<State>)
      },
      open,
      publish: (tx, next, options) => mutate(tx, context => {
        if (!owned.has(next)) throw new Error("Foreign version")
        const actual = head(key)
        if (actual !== options.expected) throw new Error("Published head changed")
        if (actual === next.reference) return
        const previous = actual && saved(actual)
        if (previous && previous.sequence !== null && (next.sequence === null || next.sequence <= previous.sequence)) throw new Error("Published sequence must advance")
        persist(next.reference, context)
        query("INSERT INTO grove_state_heads VALUES(?,?,?) ON CONFLICT(scope,name) DO UPDATE SET reference=excluded.reference", [scope, key, next.reference])
        context.committed.push(() => { cached = next })
        context.rollback.add(() => { cached = undefined })
      }),
    }
  }
  return {
    materialize, transaction,
    stats: () => ({ stagedVersions: drafts.size, ...reconcile.stats(), sqlStatements, cellWrites, encodedBytes }),
    retain: (tx, owner, reference) => mutate(tx, context => {
      const existing = query<{ reference: string }>("SELECT reference FROM grove_state_owners WHERE scope=? AND name=?", [scope, name(owner)])[0]
      if (existing && existing.reference !== reference) throw new Error("Retained owner changed")
      persist(reference, context)
      query("INSERT OR IGNORE INTO grove_state_owners VALUES(?,?,?)", [scope, owner, reference])
    }),
    release: (tx, owner, options) => mutate(tx, () => {
      const existing = query<{ reference: string }>("SELECT reference FROM grove_state_owners WHERE scope=? AND name=?", [scope, name(owner)])[0]
      if (existing && existing.reference !== options.expected) throw new Error("Retained owner changed")
      query("DELETE FROM grove_state_owners WHERE scope=? AND name=?", [scope, owner])
    }),
    discard: (keep = []) => {
      if (coordinator.active()) throw new Error("Cannot discard during transaction")
      const live = new Set<string>()
      const visit = (reference: string) => { if (live.has(reference)) return; live.add(reference); const parent = drafts.get(reference)?.parent; if (parent) visit(parent) }
      for (const reference of keep) visit(reference)
      for (const reference of drafts.keys()) if (!live.has(reference)) drafts.delete(reference)
    },
    collect: (keep = []) => transaction(tx => mutate(tx, () => {
      const roots = new Set([...participant.roots(), ...keep])
      for (const weak of shared.participants) { const other = weak.deref(); if (!other) shared.participants.delete(weak); else if (other.scope === scope) for (const root of other.roots()) roots.add(root) }
      query("DELETE FROM grove_state_gc_pins WHERE scope=?", [scope])
      query("INSERT INTO grove_state_gc_pins SELECT scope,reference,document,revision FROM grove_state_versions WHERE scope=? AND reference IN (SELECT reference FROM grove_state_heads WHERE scope=? UNION SELECT reference FROM grove_state_owners WHERE scope=?)", [scope, scope, scope])
      for (const reference of roots) query("INSERT OR IGNORE INTO grove_state_gc_pins SELECT scope,reference,document,revision FROM grove_state_versions WHERE scope=? AND reference=?", [scope, reference])
      query("DELETE FROM grove_state_history AS h WHERE scope=? AND NOT EXISTS(SELECT 1 FROM grove_state_gc_pins p WHERE p.scope=h.scope AND p.document=h.document AND p.revision>=h.since AND p.revision<h.until)", [scope])
      for (const table of ["current", "documents"]) query(`DELETE FROM grove_state_${table} WHERE scope=? AND document NOT IN (SELECT document FROM grove_state_gc_pins WHERE scope=?)`, [scope, scope])
      query("DELETE FROM grove_state_versions WHERE scope=? AND reference NOT IN (SELECT reference FROM grove_state_gc_pins WHERE scope=?)", [scope, scope])
      query("DELETE FROM grove_state_chunks AS c WHERE scope=? AND NOT EXISTS(SELECT 1 FROM grove_state_current s WHERE s.scope=c.scope AND s.document=c.document AND s.path=c.path AND s.since=c.since) AND NOT EXISTS(SELECT 1 FROM grove_state_history h WHERE h.scope=c.scope AND h.document=c.document AND h.path=c.path AND h.since=c.since)", [scope])
      query("DELETE FROM grove_state_gc_pins WHERE scope=?", [scope])
    })),
  }
}
