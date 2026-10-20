import { memory } from "./memory"
import { DEFAULT_CHUNK_BYTES as DEFAULT_REDUCER_CHUNK_BYTES } from "../reducer/sqlite"
import { DEFAULT_MAX_PARAMETERS } from "../storage/sqlite/chunks"
import { Schema } from "effect"
import { makeLegacySync, type SyncOptions as LegacyOptions, type SyncStore as LegacyStore, type SyncSqlite, type Commit, type Transaction } from "../storage/sqlite/store"
import type { Value } from "./document"
import { decodeReference, encodeReference, selectionValueReference, type Json, type Selection, type ValueReference } from "../index"
import { referenceLocator, isValueReference } from "../value"
import { localOwners } from "../session/ownership"
import { transactions } from "../storage/transaction"
import { pageStore, DEFAULT_DIRTY_BYTES, type PageOptions } from "./storage"
type Node = Value
type StoredNode = Value
import { session } from "./session"

export interface SyncOptions extends LegacyOptions, PageOptions {}
const connections = new WeakMap<object, Set<WeakRef<{ readonly flush: (tx: Transaction) => readonly Json[]; readonly clear: () => void; readonly held: () => readonly string[] }>>>()

// makeSync shares JSON page persistence with journal transactions (test/pages.test.ts).
export function makeSync(driver: SyncSqlite, options: SyncOptions): SyncStore {
  if (typeof options.scope !== "string" || !options.scope.trim()) throw new Error("Grove storage scope must be nonempty")
  const pages = pageStore(driver, options), coordinator = transactions(driver), scope = `${options.scope}/pages`
  let legacy = driver.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('grove_value_nodes','grove_nodes')", []).length ? makeLegacySync(driver, options) : undefined
  const native = () => legacy ??= makeLegacySync(driver, options)
  const emptyStats = { ...memory().stats(), reducer: { visitedValues: 0, arrayEntriesVisited: 0, cellWrites: 0, encodedBytes: 0, sqlStatements: 0, stagedVersions: 0 }, reducerChunkBytes: options.reducerChunkBytes ?? DEFAULT_REDUCER_CHUNK_BYTES, chunkBytes: pages.config.chunkBytes, maxParameters: options.maxParameters ?? DEFAULT_MAX_PARAMETERS, activeLeases: 0, leasedRoots: 0, localHolders: 0, heldReferences: 0 }
  if (!Number.isSafeInteger(emptyStats.maxParameters) || emptyStats.maxParameters < 5) throw new RangeError("maxParameters must be a safe integer of at least five")
  const legacyStats = () => legacy?.stats() ?? emptyStats
  const dirtyBytes = options.dirtyBytes ?? DEFAULT_DIRTY_BYTES
  if (!Number.isSafeInteger(dirtyBytes) || dirtyBytes < 0) throw new RangeError("Invalid dirty page budget")
  for (const sql of [
    "CREATE TABLE IF NOT EXISTS grove_page_settings(scope TEXT PRIMARY KEY,capacity INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS grove_page_versions(scope TEXT,root TEXT,value TEXT NOT NULL,PRIMARY KEY(scope,root))",
    "CREATE TABLE IF NOT EXISTS grove_page_owners(scope TEXT,name TEXT,reference TEXT NOT NULL,root TEXT NOT NULL,PRIMARY KEY(scope,name))",
  ]) driver.execute(sql, [])
  driver.execute("INSERT OR IGNORE INTO grove_page_settings VALUES(?,?)", [scope, pages.config.capacity])
  if (Number(driver.execute("SELECT capacity FROM grove_page_settings WHERE scope=?", [scope])[0]!.capacity) !== pages.config.capacity) throw new Error("Working page capacity differs from storage")
  let shared = connections.get(driver.identity)
  if (!shared) { shared = new Set(); connections.set(driver.identity, shared) }
  const peers = shared
  const mutate = <A>(tx: Transaction, work: () => A): A => {
    const context = coordinator.guard(tx)
    try { return work() } catch (cause) { context.failed = { cause }; throw cause }
  }
  const drafts = new Map<string, Node>(), held = localOwners<ValueReference<unknown>>(encodeReference, ref => referenceLocator(ref, scope).root)
  let flushedAllocation = pages.stats().allocatedBytes, budgetFlushes = 0
  const owns = (ref: ValueReference<unknown>) => JSON.parse(encodeReference(ref)).scope === scope
  const locate = (ref: ValueReference<unknown>) => referenceLocator(ref, scope)
  const root = (id: string): Node => {
    const draft = drafts.get(id)
    if (draft !== undefined) return draft
    const row = driver.execute("SELECT value FROM grove_page_versions WHERE scope=? AND root=?", [scope, id])[0]
    if (!row) throw new Error("Working snapshot expired or missing")
    return pages.decode(JSON.parse(String(row.value)))
  }
  const rebase = (tx: Transaction, id: string, node: StoredNode) => {
    const before = drafts.get(id)
    coordinator.guard(tx).committed.push(() => { if (before !== undefined && drafts.get(id) === before) drafts.set(id, node) })
  }
  const persist = (tx: Transaction, ref: ValueReference<unknown>) => {
    const { root: id } = locate(ref), existing = tx.execute("SELECT value FROM grove_page_versions WHERE scope=? AND root=?", [scope, id])[0]
    if (existing) return pages.decode(JSON.parse(String(existing.value)))
    const stored = pages.persist(tx, root(id))
    tx.execute("INSERT INTO grove_page_versions VALUES(?,?,?)", [scope, id, JSON.stringify(stored)])
    const node = pages.decode(stored); rebase(tx, id, node); return node
  }
  const stage = (node: Node) => {
    const id = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "")
    drafts.set(id, node); return id
  }
  const { bind, materialize, values, register, documents } = session({ engine: pages, scope, root, stage, readLegacy: ref => native().readValue(ref) })
  const owners = (prefix: string) => driver.execute("SELECT name,reference FROM grove_page_owners WHERE scope=? AND substr(name,1,length(?))=? ORDER BY name", [scope, prefix, prefix]).map(row => ({ name: String(row.name), reference: decodeReference(String(row.reference)) }))
  const owner = (name: string) => owners(name).find(row => row.name === name)?.reference ?? legacy?.owner(name) ?? null
  const put = (tx: Transaction, name: string, ref: ValueReference<unknown>) => {
    if (!name.trim()) throw new Error("Owner must be nonempty")
    persist(tx, ref)
    tx.execute("INSERT INTO grove_page_owners VALUES(?,?,?,?) ON CONFLICT(scope,name) DO UPDATE SET reference=excluded.reference,root=excluded.root", [scope, name, encodeReference(ref), locate(ref).root])
  }
  const tokenReference = (token: Selection<unknown> | ValueReference<unknown>) => isValueReference(token) ? token : selectionValueReference(token) ?? native().reference(token as Selection<unknown>)
  const commit = (tx: Transaction, changes: Commit) => mutate(tx, () => {
    const before = pages.stats()
    const claimed = new Set<string>()
    for (const change of [...changes.publish ?? [], ...changes.retain ?? [], ...changes.release ?? []]) {
      if (!change.owner.trim() || claimed.has(change.owner)) throw new Error("Invalid or duplicate Grove owner")
      claimed.add(change.owner)
    }
    const legacy: { publish: NonNullable<Commit["publish"]>[number][]; retain: NonNullable<Commit["retain"]>[number][]; release: NonNullable<Commit["release"]>[number][] } = { publish: [], retain: [], release: [] }
    for (const change of changes.publish ?? []) {
      const ref = isValueReference(change.document) ? change.document : (change.document as { readonly reference: ValueReference<unknown> }).reference
      if (!owns(ref)) { legacy.publish.push(change); continue }
      if ((owner(change.owner) ? encodeReference(owner(change.owner)!) : null) !== (change.expected ? encodeReference(change.expected) : null)) throw new Error("Working owner changed")
      const location = locate(ref)
      if (location.path.length || location.each !== undefined || location.range !== undefined) throw new Error("Publication requires whole-document reference")
      if (!isValueReference(change.document) && !documents.has(change.document)) throw new Error("Foreign Grove document")
      if (change.expected && !owns(change.expected)) native().commit(tx, { release: [{ owner: change.owner, expected: change.expected }] })
      put(tx, change.owner, ref)
    }
    for (const change of changes.retain ?? []) {
      const ref = tokenReference(change.selection)
      if (!owns(ref)) { legacy.retain.push(change); continue }
      const actual = owner(change.owner)
      if (actual && encodeReference(actual) !== encodeReference(ref)) throw new Error("Retained working input changed")
      put(tx, change.owner, ref)
    }
    for (const change of changes.release ?? []) {
      if (!owns(change.expected)) { legacy.release.push(change); continue }
      const actual = owner(change.owner)
      if (actual && encodeReference(actual) !== encodeReference(change.expected)) throw new Error("Working owner changed")
      tx.execute("DELETE FROM grove_page_owners WHERE scope=? AND name=?", [scope, change.owner])
    }
    const result = legacy.publish.length || legacy.retain.length || legacy.release.length ? native().commit(tx, legacy) : { nodes: 0, bytes: 0, rows: 0 }
    const after = pages.stats()
    return { nodes: result.nodes + after.writes - before.writes, bytes: result.bytes + after.writtenBytes - before.writtenBytes, rows: result.rows }
  })
  const flushHeld = (tx: Transaction) => {
    const roots = new Set(held.held().map(ref => locate(ref).root)), result: StoredNode[] = []
    for (const id of roots) { const stored = pages.persist(tx, root(id)); rebase(tx, id, pages.decode(stored)); result.push(pages.decode(stored)) }
    const allocated = pages.stats().allocatedBytes
    coordinator.guard(tx).committed.push(() => { flushedAllocation = allocated })
    return result
  }
  const participant = { flush: (tx: Transaction) => flushHeld(tx).map(node => pages.persist(tx, node)), clear: pages.clear, held: () => held.held().map(encodeReference) }
  peers.add(new WeakRef(participant))
  let activeLeases = 0
  const view: LegacyStore["view"] = (ref, schema) => {
    if (!owns(ref)) return native().view(ref, schema)
    const source = values.view(ref, schema)
    const acquire = () => {
      const location = locate(ref)
      if (!driver.execute("SELECT 1 FROM grove_page_versions WHERE scope=? AND root=?", [scope, location.root]).length) throw new Error("Grove view requires persisted backing storage")
      const holder = {}, context = coordinator.active()
      held.hold(holder, "lease", ref); activeLeases++
      let active = true
      const release = () => { if (!active) return; active = false; held.release(holder); activeLeases--; context?.rollback.delete(release) }
      context?.rollback.add(release)
      return { release, check: () => { if (!active) throw new Error("Grove read lease expired") } }
    }
    const read = <A>(work: () => A) => { const lease = acquire(); try { return work() } finally { lease.release() } }
    return { read: path => read(() => source.read(path)), length: path => read(() => source.length(path)), materialize: () => read(source.materialize),
      scan: (path, range) => (function* () { const lease = acquire(); try { const iterator = source.scan(path, range); try { while (true) { lease.check(); const item = iterator.next(); if (item.done) return; yield item.value } } finally { iterator.return?.() } } finally { lease.release() } })(),
    }
  }
  return {
    bind, materialize,
    transactionActive: () => coordinator.active() !== undefined,
    reference: <Value>(selection: Selection<Value>) => (selectionValueReference(selection) ?? native().reference(selection)) as ValueReference<Value>,
    syncHeld: (tx, prefix) => { coordinator.guard(tx); legacy?.syncHeld(tx, prefix) },
    capture: value => values.reference(register(stage(pages.from(value)))),
    transaction: work => coordinator.transaction(tx => { const result = work(tx); if (pages.stats().allocatedBytes - flushedAllocation > dirtyBytes) { flushHeld(tx); budgetFlushes++ }; return result }),
    commit,
    owners: prefix => [...(legacy?.owners(prefix) ?? []), ...owners(prefix)],
    owner,
    replaceOwners: (tx, prefix, refs) => mutate(tx, () => {
      coordinator.guard(tx)
      for (const previous of owners(prefix)) tx.execute("DELETE FROM grove_page_owners WHERE scope=? AND name=?", [scope, previous.name])
      const desired = new Map(refs.map((ref, index) => [prefix + index, ref]))
      for (const previous of legacy?.owners(prefix) ?? []) if (!desired.has(previous.name) || owns(desired.get(previous.name)!)) native().commit(tx, { release: [{ owner: previous.name, expected: previous.reference }] })
      for (const [name, ref] of desired) {
        if (owns(ref)) put(tx, name, ref)
        else native().commit(tx, { retain: [{ owner: name, selection: ref }] })
      }
    }),
    hold: (holder, name, ref) => { if (owns(ref)) held.hold(holder, name, ref); else native().hold(holder, name, ref) },
    release: holder => { held.release(holder); legacy?.release(holder) },
    held: () => [...(legacy?.held() ?? []), ...held.held()],
    view,
    readValue: ref => owns(ref) ? values.view(ref, Schema.Json).materialize() : native().readValue(ref),
    bytes: ref => {
      if (!owns(ref)) return native().bytes(ref)
      const location = locate(ref)
      if (location.each || location.range) return Buffer.byteLength(JSON.stringify(values.view(ref, Schema.Json).materialize()))
      return Buffer.byteLength(JSON.stringify(pages.materialize(pages.select(root(location.root), location.path))))
    },
    discard: () => { if (coordinator.active()) throw new Error("Cannot discard staged changes during a transaction"); legacy?.discard(); const active = new Set(held.held().map(ref => locate(ref).root)); for (const id of drafts.keys()) if (!active.has(id)) drafts.delete(id);  },
    clear: () => { legacy?.clear(); pages.clear() },
    collect: () => coordinator.transaction(tx => {
      const active: Json[] = []
      for (const peer of peers) { const live = peer.deref(); if (live) active.push(...live.flush(tx)); else peers.delete(peer) }

      const roots = [...peers].flatMap(peer => peer.deref()?.held() ?? []).map(encoded => JSON.parse(encoded) as { scope: string; selection: { root: string } }).filter(ref => ref.scope === scope).map(ref => ref.selection.root)
      tx.execute("DELETE FROM grove_page_versions WHERE scope=? AND root NOT IN (SELECT root FROM grove_page_owners WHERE scope=?) AND root NOT IN (SELECT value FROM json_each(?))", [scope, scope, JSON.stringify(roots)])
      const stored = driver.execute("SELECT value FROM grove_page_versions", []).map(row => pages.decode(JSON.parse(String(row.value))))
      const result = legacy?.collect() ?? { nodes: 0, bytes: 0, rows: 0 }; pages.collect(tx, [...active, ...stored.map(node => pages.persist(tx, node))]); coordinator.guard(tx).committed.push(() => { for (const peer of peers) peer.deref()?.clear() }); return result
    }),
    stats: () => ({ ...legacyStats(), stagedNodes: [...drafts.values()].filter(node => node !== null && typeof node === "object" && (node.type === "text" ? "value" in node : node.type === "field" || node.root.type !== "stored")).length + legacyStats().stagedNodes, activeLeases, pageParticipants: participant ? peers.size : 0, localHolders: held.size + legacyStats().localHolders, heldReferences: held.held().length + legacyStats().heldReferences, pages: { ...pages.stats(), drafts: drafts.size, holders: held.size, budgetFlushes, dirtyBudgetBytes: dirtyBytes, allocatedSinceFlush: pages.stats().allocatedBytes - flushedAllocation } }),
  }
}

export interface SyncStore extends Omit<LegacyStore, "stats"> {
  readonly stats: () => ReturnType<LegacyStore["stats"]> & {
    readonly pages: ReturnType<ReturnType<typeof pageStore>["stats"]> & { readonly drafts: number; readonly holders: number; readonly budgetFlushes: number; readonly dirtyBudgetBytes: number; readonly allocatedSinceFlush: number }
  }
}
