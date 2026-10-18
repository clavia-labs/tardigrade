import { commitMaps, type MapBatch } from "../../collections/key-value"
import { makeMapStorage } from "./key-value"
import { commitLogs, type LogBatch } from "../../collections/append-only"
import { makeRowStorage } from "./append-only"
import { localOwners } from "../../session/ownership"
import { Schema } from "effect"
import { digest, encodeNode, type Json } from "../nodes"
import { make, documentReference, type Selection, type StagedNodes } from "../../document"
import { decodeReference, encodeReference, isValueReference, referenceLocator, type ValueReference, type View, type ValueRange } from "../../value"
import { NODE_QUERY, decodeNodeChunks, textChunks, packDigests, unpackDigests, DEFAULT_CHUNK_BYTES, DEFAULT_MAX_PARAMETERS, type NodeChunk } from "./chunks"
import type { ReaderOptions } from "../../session/reader"

export type SqliteParameter = string | number | null | Uint8Array
// SyncSqlite requires exclusive access through a synchronous connection; handles for that connection share identity (test/transactions.test.ts; test/workerd/recovery.workers.ts).
export interface SyncSqlite {
  readonly identity: object
  readonly execute: (statement: string, parameters: readonly SqliteParameter[]) => readonly Record<string, unknown>[]
  readonly transaction: <Value>(work: () => Value) => Value
}
export interface SyncOptions extends ReaderOptions { readonly scope: string; readonly chunkBytes?: number; readonly maxParameters?: number }
const TransactionType = Symbol("GroveTransaction")
export interface Transaction {
  readonly [TransactionType]: true
  readonly execute: SyncSqlite["execute"]
}
export interface Commit {
  readonly publish?: readonly { readonly owner: string; readonly expected: ValueReference<unknown> | null; readonly document: { readonly reference: ValueReference<unknown> } | ValueReference<unknown> }[]
  readonly retain?: readonly { readonly owner: string; readonly selection: Selection<unknown> | ValueReference<unknown> }[]
  readonly release?: readonly { readonly owner: string; readonly expected: ValueReference<unknown> }[]
}
export interface CommitResult { readonly nodes: number; readonly bytes: number; readonly rows: number }
interface Context {
  readonly identity: object
  readonly committed: (() => void)[]
  readonly rollback: Set<() => void>
  failed?: { readonly cause: unknown }
}
interface HeldSnapshot { readonly roots: readonly string[]; readonly nodes: StagedNodes; readonly logs: LogBatch; readonly maps: MapBatch }
interface Connection { readonly readers: Set<WeakRef<() => void>>; readonly leases: Map<string, number>; readonly holders: Map<object, () => HeldSnapshot>; active?: Context }
const connections = new WeakMap<object, Connection>()
const transactions = new WeakMap<object, Context>()
const thenable = (value: unknown) => value !== null && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function"
const ownerName = (name: string) => { if (typeof name !== "string" || !name.trim()) throw new Error("Grove owner name must be nonempty"); return name }

// makeSync commits references and application writes on a synchronous SQLite connection (test/transactions.test.ts; test/workerd/recovery.workers.ts).
export function makeSync(driver: SyncSqlite, options: SyncOptions) {
  if (typeof options.scope !== "string" || !options.scope.trim()) throw new Error("Grove storage scope must be nonempty")
  const scope = options.scope
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES
  const maxParameters = options.maxParameters ?? DEFAULT_MAX_PARAMETERS
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error("chunkBytes must be a positive safe integer")
  if (!Number.isSafeInteger(maxParameters) || maxParameters < 5) throw new Error("maxParameters must be a safe integer of at least five")
  let connection = connections.get(driver.identity)
  if (!connection) { connection = { readers: new Set(), leases: new Map(), holders: new Map() }; connections.set(driver.identity, connection) }
  const shared = connection
  const query = <Row>(statement: string, parameters: readonly SqliteParameter[] = []): readonly Row[] => {
    const rows = driver.execute(statement, parameters)
    if (!Array.isArray(rows)) throw new Error("Grove SQLite statements must complete synchronously")
    return rows as readonly Row[]
  }
  for (const statement of [
    "CREATE TABLE IF NOT EXISTS grove_value_nodes(hash TEXT PRIMARY KEY,byte_length INTEGER NOT NULL,chunk_count INTEGER NOT NULL,children BLOB NOT NULL,payload BLOB) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS grove_value_chunks(hash TEXT NOT NULL,ordinal INTEGER NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(hash,ordinal)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS grove_value_owners(scope TEXT NOT NULL,name TEXT NOT NULL,reference TEXT NOT NULL,root TEXT NOT NULL,PRIMARY KEY(scope,name)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS grove_value_gc_live(hash TEXT PRIMARY KEY,expanded INTEGER NOT NULL) WITHOUT ROWID",
    "CREATE INDEX IF NOT EXISTS grove_value_gc_frontier ON grove_value_gc_live(expanded,hash)",
  ]) query(statement)
  const exists = (hash: string) => query("SELECT hash FROM grove_value_nodes WHERE hash=?", [hash]).length !== 0
  const load = (hash: string) => decodeNodeChunks(query<NodeChunk>(NODE_QUERY, [hash]))
  const rows = makeRowStorage(query, chunkBytes)
  const maps = makeMapStorage(query, chunkBytes)
  const base = make({ load, scope, options, rows, maps })
  shared.readers.add(new WeakRef(base.clear))
  const clearReaders = () => {
    for (const ref of shared.readers) { const clear = ref.deref(); if (clear) clear(); else shared.readers.delete(ref) }
  }
  const ownership = localOwners<ValueReference<unknown>>(encodeReference, ref => referenceLocator(ref, scope).root)
  const heldRoots = () => ownership.held().map(ref => referenceLocator(ref, scope).root)
  const hold = (holder: object, name: string, ref: ValueReference<unknown>) => {
    referenceLocator(ref, scope)
    ownership.hold(holder, name, ref)
    if (!shared.holders.has(ownership)) shared.holders.set(ownership, () => { const roots = heldRoots(); const batch = base.staging.prepare(ownership.held()); return { roots, nodes: batch.nodes, logs: batch.logs, maps: batch.maps } })
  }
  const release = (holder: object) => {
    ownership.release(holder)
    if (!ownership.size) shared.holders.delete(ownership)
  }
  const guard = (tx: Transaction): Context => {
    const context = transactions.get(tx)
    if (!context || context !== shared.active || context.identity !== driver.identity) throw new Error("Grove transaction is expired or belongs to another connection")
    if (context.failed) throw context.failed.cause
    return context
  }
  const mutate = <Value>(tx: Transaction, work: (context: Context) => Value): Value => {
    const context = guard(tx)
    context.rollback.add(base.clear)
    try { return work(context) } catch (cause) { context.failed = { cause }; throw cause }
  }
  const invoke = <Value>(context: Context, work: (tx: Transaction) => Value): Value => {
    const tx = Object.freeze({ execute: (statement: string, parameters: readonly SqliteParameter[]) => mutate(tx as Transaction, () => query<Record<string, unknown>>(statement, parameters)) }) as Transaction
    transactions.set(tx, context)
    try {
      const result = work(tx)
      if (thenable(result)) throw new Error("Grove transaction callbacks must be synchronous")
      if (context.failed) throw context.failed.cause
      return result
    } catch (cause) { context.failed = { cause }; throw cause }
    finally { transactions.delete(tx) }
  }
  const transaction = <Value>(work: (tx: Transaction) => Value): Value => {
    if (shared.active) return invoke(shared.active, work)
    const context: Context = { identity: driver.identity, committed: [], rollback: new Set([base.clear]) }
    let result: Value
    try {
      result = driver.transaction(() => {
        shared.active = context
        try { return invoke(context, work) } finally { delete shared.active }
      })
      if (thenable(result)) throw new Error("Grove SQLite transactions must complete synchronously")
    } catch (cause) {
      clearReaders()
      for (const clear of context.rollback) clear()
      context.rollback.clear(); context.committed.length = 0
      throw cause
    }
    try { for (const acknowledge of context.committed) acknowledge() }
    finally { context.rollback.clear(); context.committed.length = 0 }
    return result
  }
  const owner = (name: string): ValueReference | null => {
    const row = query<{ reference: string }>("SELECT reference FROM grove_value_owners WHERE scope=? AND name=?", [scope, ownerName(name)])[0]
    if (!row) return null
    const ref = decodeReference(row.reference)
    referenceLocator(ref, scope)
    return ref
  }
  const expected = (name: string, ref: ValueReference<unknown> | null) => {
    if (ref) referenceLocator(ref, scope)
    const actual = owner(name)
    if ((actual ? encodeReference(actual) : null) !== (ref ? encodeReference(ref) : null)) throw new Error(`Grove owner changed: ${name}`)
  }
  const groups = function* <Value>(values: readonly Value[]): IterableIterator<readonly Value[]> {
    for (let index = 0; index < values.length; index += maxParameters) yield values.slice(index, index + maxParameters)
  }
  const existing = (hashes: readonly string[]) => {
    const found = new Set<string>()
    for (const batch of groups(hashes)) for (const row of query<{ hash: string }>(`SELECT hash FROM grove_value_nodes WHERE hash IN (${batch.map(() => "?").join(",")})`, batch)) found.add(row.hash)
    return found
  }
  const commit = (tx: Transaction, changes: Commit): CommitResult => mutate(tx, context => {
    const claimed = new Set<string>()
    const claim = (name: string) => { ownerName(name); if (claimed.has(name)) throw new Error(`Duplicate Grove owner: ${name}`); claimed.add(name) }
    const publications = (changes.publish ?? []).map(change => {
      claim(change.owner)
      const ref = isValueReference(change.document) ? change.document : documentReference(base, change.document)
      const locator = referenceLocator(ref, scope)
      if (locator.path.length || locator.each !== undefined || locator.range !== undefined) throw new Error("Publication requires a whole-document reference")
      expected(change.owner, change.expected)
      return { owner: change.owner, ref }
    })
    const retained = (changes.retain ?? []).map(change => {
      claim(change.owner)
      const ref = isValueReference(change.selection) ? change.selection : base.reference(change.selection)
      referenceLocator(ref, scope)
      const current = owner(change.owner)
      if (current && encodeReference(current) !== encodeReference(ref)) throw new Error(`Grove owner already retains another value: ${change.owner}`)
      return { owner: change.owner, ref }
    })
    for (const change of changes.release ?? []) {
      claim(change.owner)
      referenceLocator(change.expected, scope)
      const actual = owner(change.owner)
      if (actual && encodeReference(actual) !== encodeReference(change.expected)) throw new Error(`Grove owner changed: ${change.owner}`)
    }
    const owners = [...publications, ...retained]
    const roots = owners.map(entry => referenceLocator(entry.ref, scope).root)
    const batch = base.staging.prepare(owners.map(entry => entry.ref))
    const staged = batch.nodes
    const logWritten = commitLogs(rows, batch.logs), mapWritten = commitMaps(maps, batch.maps)
    const written = { rows: logWritten.rows + mapWritten.rows, bytes: logWritten.bytes + mapWritten.bytes }
    const present = existing([...staged.keys()])
    let nodes = 0, bytes = written.bytes
    for (const [hash, node] of staged) {
      const text = encodeNode(node)
      if (present.has(hash)) {
        if (load(hash) !== text) throw new Error("Conflicting immutable Grove node")
        continue
      }
      if (digest(text) !== hash) throw new Error(`Shared JSON node missing or corrupt: ${hash}`)
      const byteLength = Buffer.byteLength(text, "utf8"), children = packDigests([...new Set(node.children)])
      const pieces = textChunks(text, chunkBytes)
      query("INSERT INTO grove_value_nodes VALUES(?,?,?,?,NULL)", [hash, byteLength, pieces.length, children])
      pieces.forEach((piece, ordinal) => query("INSERT INTO grove_value_chunks VALUES(?,?,?)", [hash, ordinal, piece]))
      nodes++; bytes += byteLength
    }
    const dependencies = [...new Set([...staged.values()].flatMap(node => node.children))].filter(hash => !staged.has(hash))
    if (existing(dependencies).size !== dependencies.length) throw new Error("Grove commit references a missing dependency")
    for (const hash of roots) if (!staged.has(hash) && !exists(hash)) throw new Error("Grove commit references a missing root")
    for (const entry of owners) query("INSERT INTO grove_value_owners VALUES(?,?,?,?) ON CONFLICT(scope,name) DO UPDATE SET reference=excluded.reference,root=excluded.root", [scope, entry.owner, encodeReference(entry.ref), referenceLocator(entry.ref, scope).root])
    for (const change of changes.release ?? []) query("DELETE FROM grove_value_owners WHERE scope=? AND name=?", [scope, change.owner])
    context.committed.push(() => base.staging.acknowledge(batch))
    return { nodes, bytes, rows: written.rows }
  })
  // replaceOwners reconciles a prefixed durable owner group atomically (test/transactions.test.ts).
  const replaceOwners = (tx: Transaction, prefix: string, references: readonly ValueReference<unknown>[]) => mutate(tx, () => {
    ownerName(prefix)
    const desired = new Map(references.map((ref, index) => {
      referenceLocator(ref, scope)
      return [prefix + index, ref] as const
    }))
    for (const owned of owners(prefix)) {
      const next = desired.get(owned.name)
      if (next && encodeReference(next) === encodeReference(owned.reference)) { desired.delete(owned.name); continue }
      commit(tx, { release: [{ owner: owned.name, expected: owned.reference }] })
    }
    for (const [owner, selection] of desired) commit(tx, { retain: [{ owner, selection }] })
  })
  // syncHeld keeps one owner per locally held reference under prefix, named by the reference's digest so a held value keeps its row while others change.
  // It writes only identities held or unheld since the previous sync; the first sync and any sync after a rollback reconcile the whole group.
  let heldPrefix: string | undefined
  const syncHeld = (tx: Transaction, prefix: string) => mutate(tx, context => {
    ownerName(prefix)
    if (heldPrefix !== undefined && heldPrefix !== prefix) throw new Error("Local holders already sync to another owner prefix")
    const changes = ownership.drain()
    context.rollback.add(() => { heldPrefix = undefined })
    const name = (encoded: string) => prefix + digest(encoded)
    if (heldPrefix === undefined) {
      const desired = new Map(ownership.held().map(ref => [name(encodeReference(ref)), ref] as const))
      for (const owned of owners(prefix)) if (!desired.delete(owned.name)) commit(tx, { release: [{ owner: owned.name, expected: owned.reference }] })
      for (const [owner, selection] of desired) commit(tx, { retain: [{ owner, selection }] })
      heldPrefix = prefix
      return
    }
    for (const encoded of changes.removed) commit(tx, { release: [{ owner: name(encoded), expected: decodeReference(encoded) }] })
    for (const [encoded, selection] of changes.added) commit(tx, { retain: [{ owner: name(encoded), selection }] })
  })
  const owners = (prefix: string) => query<{ name: string; reference: string }>("SELECT name,reference FROM grove_value_owners WHERE scope=? AND substr(name,1,length(?))=? ORDER BY name", [scope, prefix, prefix]).map(row => ({ name: row.name, reference: decodeReference(row.reference) }))
  const acquire = (ref: ValueReference<unknown>) => {
    const { root } = referenceLocator(ref, scope)
    if (!exists(root)) throw new Error("Grove view requires persisted backing storage")
    const context = shared.active
    context?.rollback.add(base.clear)
    shared.leases.set(root, (shared.leases.get(root) ?? 0) + 1)
    let active = true
    const release = () => {
      if (!active) return
      active = false
      context?.rollback.delete(release)
      const count = shared.leases.get(root)! - 1
      if (count) shared.leases.set(root, count); else shared.leases.delete(root)
    }
    context?.rollback.add(release)
    return { release, check: () => { if (!active) throw new Error("Grove read lease expired") } }
  }
  const view = <Value extends Json>(ref: ValueReference<unknown>, schema: Schema.Decoder<Value>): View<Value> => {
    const source = base.view(ref, schema)
    const read = <Result>(work: () => Result) => { const lease = acquire(ref); try { return work() } finally { lease.release() } }
    return Object.freeze({
      read: ((path) => read(() => source.read(path))) as View<Value>["read"],
      length: ((path) => read(() => source.length(path))) as View<Value>["length"],
      materialize: () => read(source.materialize),
      scan: ((path, range?: ValueRange) => {
        const iterator = source.scan(path, range)
        return (function* () {
          const lease = acquire(ref)
          try {
            while (true) {
              lease.check()
              const item = iterator.next()
              if (item.done) return
              yield item.value
            }
          } finally { iterator.return?.(); lease.release() }
        })()
      }) as View<Value>["scan"],
    })
  }
  const collect = () => transaction(tx => mutate(tx, () => {
    const before = query<{ nodes: number; bytes: number }>("SELECT COUNT(*) nodes,COALESCE(SUM(byte_length),0) bytes FROM grove_value_nodes")[0]!
    query("DELETE FROM grove_value_gc_live")
    query("INSERT OR IGNORE INTO grove_value_gc_live SELECT root,0 FROM grove_value_owners")
    const held = [...shared.holders.values()].map(snapshot => snapshot())
    const staged = new Map(held.flatMap(snapshot => [...snapshot.nodes]))
    for (const root of [...shared.leases.keys(), ...held.flatMap(snapshot => snapshot.roots)]) query("INSERT OR IGNORE INTO grove_value_gc_live VALUES(?,0)", [root])
    while (true) {
      const frontier = query<{ hash: string; children: Uint8Array | ArrayBuffer | null }>("SELECT l.hash,n.children FROM grove_value_gc_live l LEFT JOIN grove_value_nodes n ON n.hash=l.hash WHERE l.expanded=0 LIMIT ?", [maxParameters])
      if (!frontier.length) break
      for (const row of frontier) {
        let children = staged.get(row.hash)?.children
        if (!children) {
          if (row.children === null) throw new Error("Grove collection found a missing live node")
          const packed = row.children instanceof Uint8Array ? row.children : new Uint8Array(row.children)
          if (packed.byteLength % 32) throw new Error("Invalid Grove child index")
          children = unpackDigests(packed)
        }
        for (const batch of groups(children)) query(`INSERT OR IGNORE INTO grove_value_gc_live VALUES ${batch.map(() => "(?,0)").join(",")}`, batch)
        query("UPDATE grove_value_gc_live SET expanded=1 WHERE hash=?", [row.hash])
      }
    }
    const rowResult = rows.collect(held.flatMap(snapshot => snapshot.logs.writes.flatMap(write => write.parent ? [write.parent.hash] : [])))
    const mapResult = maps.collect(held.flatMap(snapshot => snapshot.maps.writes.flatMap(write => write.parent ? [write.parent.hash] : [])))
    query("DELETE FROM grove_value_chunks WHERE hash NOT IN (SELECT hash FROM grove_value_gc_live)")
    query("DELETE FROM grove_value_nodes WHERE hash NOT IN (SELECT hash FROM grove_value_gc_live)")
    query("DELETE FROM grove_value_gc_live")
    const after = query<{ nodes: number; bytes: number }>("SELECT COUNT(*) nodes,COALESCE(SUM(byte_length),0) bytes FROM grove_value_nodes")[0]!
    clearReaders()
    return { nodes: before.nodes - after.nodes, bytes: before.bytes - after.bytes + rowResult.bytes + mapResult.bytes, rows: rowResult.rows + mapResult.rows }
  }))
  return {
    bind: <State extends Json>(schema: Schema.Decoder<State>) => {
      const documents = base.bind(schema)
      return { initial: documents.initial, check: documents.check, open: (ref: ValueReference<unknown>) => {
        const selected = referenceLocator(ref, scope)
        if (selected.path.length || selected.each !== undefined || selected.range !== undefined) throw new Error("Opening a document requires a whole-document reference")
        if (!exists(selected.root)) throw new Error("Cannot open missing Grove document")
        return documents.open(ref)
      } }
    },
    owners, replaceOwners, syncHeld, hold, release, held: ownership.held,
    bytes: base.bytes,
    capture: base.capture,
    // readValue reads captured drafts or persisted values while local owners protect their dependencies (platform/test/properties/accepted-work.ts).
    readValue: (ref: ValueReference<unknown>): Json => {
      const { root } = referenceLocator(ref, scope)
      return base.staging.prepare([ref]).nodes.has(root) ? base.view(ref, Schema.Json).materialize() : view(ref, Schema.Json).materialize()
    },
    reference: base.reference, clear: base.clear, transactionActive: () => shared.active !== undefined, transaction, commit, owner, view, collect,
    discard: () => { if (shared.active) throw new Error("Cannot discard staged changes during a transaction"); base.staging.discard(base.staging.staged().flatMap(hash => ownership.heldAt(hash))) },
    stats: () => ({ ...base.stats(), chunkBytes, maxParameters, activeLeases: [...shared.leases.values()].reduce((sum, count) => sum + count, 0), leasedRoots: shared.leases.size, localHolders: ownership.size, heldReferences: ownership.held().length }),
  }
}
export type SyncStore = ReturnType<typeof makeSync>
