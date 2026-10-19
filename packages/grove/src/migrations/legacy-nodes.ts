import type { Selection } from "../document"
import { Schema } from "effect"
import { makeReader } from "../session/reader"
import { storedValues, referenceLocator, type ValueReference } from "../value"
import { decodeNode } from "../storage/nodes"
import { decodeNodeChunks, NODE_QUERY, packDigests, DEFAULT_MAX_PARAMETERS, type NodeChunk } from "../storage/sqlite/chunks"
import type { SyncSqlite, SyncOptions, Transaction } from "../storage/sqlite/store"

const Path = Schema.Array(Schema.Union([Schema.String, Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))]))
const Source = Schema.Struct({
  root: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)), path: Path,
  each: Schema.optionalKey(Path),
  range: Schema.optionalKey(Schema.Struct({ start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), end: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })),
})
const OLD_NODE_QUERY = NODE_QUERY.replaceAll("grove_value_", "grove_")

// legacyStore imports authenticated format-3 nodes into scoped storage (platform/test/workerd/migration.workers.ts).
export function legacyStore(driver: SyncSqlite, scope: string, options: Omit<SyncOptions, "scope"> = {}) {
  const load = (hash: string) => decodeNodeChunks(driver.execute(OLD_NODE_QUERY, [hash]) as unknown as readonly NodeChunk[])
  const reader = makeReader(load, options)
  const values = storedValues(scope, reader)
  const reference = (source: unknown) => {
    const selected = Schema.decodeUnknownSync(Source, { onExcessProperty: "error" })(source)
    if (selected.range && selected.range.start > selected.range.end) throw new Error("Invalid legacy selection range")
    const token = {}
    values.register(token, selected)
    return values.reference(token as Selection<unknown>)
  }
  const maxParameters = options.maxParameters ?? DEFAULT_MAX_PARAMETERS
  if (!Number.isSafeInteger(maxParameters) || maxParameters < 5) throw new Error("maxParameters must be a safe integer of at least five")
  const enqueue = (tx: Transaction, hashes: readonly string[]) => {
    for (let start = 0; start < hashes.length; start += maxParameters) {
      const batch = hashes.slice(start, start + maxParameters)
      tx.execute(`INSERT OR IGNORE INTO grove_value_gc_live(hash,expanded) VALUES ${batch.map(() => "(?,0)").join(",")}`, batch)
    }
  }
  const walk = (tx: Transaction, visit: (hash: string, text: string, children: readonly string[]) => void) => {
    while (true) {
      const frontier = tx.execute("SELECT hash FROM grove_value_gc_live WHERE expanded=0 LIMIT ?", [maxParameters])
      if (!frontier.length) break
      for (const row of frontier) {
        const hash = String(row.hash), text = load(hash), node = decodeNode(hash, text)
        if (node.version !== 3) throw new Error("Unsupported legacy Grove node format")
        visit(hash, text, node.children)
        enqueue(tx, node.children)
        tx.execute("UPDATE grove_value_gc_live SET expanded=1 WHERE hash=?", [hash])
      }
    }
  }
  const copy = (tx: Transaction, ref: ValueReference<unknown>) => {
    enqueue(tx, [referenceLocator(ref, scope).root])
    walk(tx, (hash, text, childHashes) => {
      const children = packDigests([...new Set(childHashes)])
      tx.execute("INSERT OR IGNORE INTO grove_value_nodes(hash,byte_length,chunk_count,children,payload) SELECT hash,byte_length,chunk_count,?,payload FROM grove_nodes WHERE hash=?", [children, hash])
      tx.execute("INSERT OR IGNORE INTO grove_value_chunks(hash,ordinal,payload) SELECT hash,ordinal,payload FROM grove_chunks WHERE hash=?", [hash])
      if (decodeNodeChunks(tx.execute(NODE_QUERY, [hash]) as unknown as readonly NodeChunk[]) !== text) throw new Error("Conflicting legacy Grove node")
      const packed = tx.execute("SELECT children FROM grove_value_nodes WHERE hash=?", [hash])[0]!.children as Uint8Array | ArrayBuffer
      if (!Buffer.from(packed instanceof Uint8Array ? packed : new Uint8Array(packed)).equals(Buffer.from(children))) throw new Error("Conflicting legacy Grove child index")
    })
  }
  const collect = (tx: Transaction) => {
    tx.execute("DELETE FROM grove_value_gc_live", [])
    tx.execute("INSERT OR IGNORE INTO grove_value_gc_live(hash,expanded) SELECT root,0 FROM grove_owners", [])
    walk(tx, () => {})
    tx.execute("DELETE FROM grove_chunks WHERE hash NOT IN (SELECT hash FROM grove_value_gc_live)", [])
    tx.execute("DELETE FROM grove_nodes WHERE hash NOT IN (SELECT hash FROM grove_value_gc_live)", [])
    tx.execute("DELETE FROM grove_value_gc_live", [])
  }
  const restoreState = (stored: unknown, root: unknown) => {
    if (stored === null || typeof stored !== "object" || Array.isArray(stored) || !("_tag" in stored) || stored._tag !== "TreeState" || !("root" in stored) || stored.root !== root || typeof root !== "string") throw new Error("Invalid legacy durable tree")
    return reader.read(root, [])
  }
  return { reference, copy, read: (root: string) => reader.read(root, []), restoreState, collect }
}
