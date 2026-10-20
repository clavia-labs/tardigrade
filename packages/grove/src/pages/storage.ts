import { digest } from "../storage/nodes"
import { documents, DEFAULT_INLINE_BYTES, type Json, type Text, type Value } from "./document"
import { DEFAULT_CAPACITY, reference, type Key, type Node, type Page, type Reference } from "./tree"
import { transactions, type Driver, type Transaction } from "../storage/transaction"
import { textChunks, DEFAULT_CHUNK_BYTES } from "../storage/sqlite/chunks"

export const DEFAULT_CACHE_BYTES = 1024 * 1024
export const DEFAULT_DIRTY_BYTES = 1024 * 1024
export interface PageOptions { readonly capacity?: number; readonly inlineBytes?: number; readonly cacheBytes?: number; readonly dirtyBytes?: number; readonly chunkBytes?: number }
const positive = (name: string, value: number, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be a safe integer of at least ${minimum}`)
  return value
}

// pageStore persists shared JSON pages inside the caller's transaction (test/pages.test.ts).
export function pageStore(driver: Driver, options: PageOptions = {}) {
  const config = Object.freeze({ capacity: positive("capacity", options.capacity ?? DEFAULT_CAPACITY, 4), inlineBytes: positive("inlineBytes", options.inlineBytes ?? DEFAULT_INLINE_BYTES), cacheBytes: positive("cacheBytes", options.cacheBytes ?? DEFAULT_CACHE_BYTES), dirtyBytes: positive("dirtyBytes", options.dirtyBytes ?? DEFAULT_DIRTY_BYTES), chunkBytes: positive("chunkBytes", options.chunkBytes ?? DEFAULT_CHUNK_BYTES, 1) })
  const coordinator = transactions(driver), query = (sql: string, parameters: readonly (string | number | null | Uint8Array)[] = []) => driver.execute(sql, parameters)
  driver.execute("CREATE TABLE IF NOT EXISTS grove_pages(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,payload TEXT,chunk_count INTEGER NOT NULL,children TEXT NOT NULL,byte_length INTEGER NOT NULL,digest TEXT NOT NULL)", [])
  driver.execute("CREATE TABLE IF NOT EXISTS grove_page_chunks(id INTEGER NOT NULL,ordinal INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,ordinal))", [])
  let identities = new WeakMap<object, Reference<Key> | number>()
  const cache = new Map<number, { readonly kind: string; readonly value: Page<Key, Value> | string; readonly bytes: number }>()
  let cachedBytes = 0
  const counters = { reads: 0, readBytes: 0, writes: 0, writtenBytes: 0, cacheHits: 0, evictions: 0, allocatedPages: 0, allocatedBytes: 0, materializations: 0 }
  const id = (value: unknown) => { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Invalid page id"); return value }
  const array = (value: unknown): readonly unknown[] => { if (!Array.isArray(value)) throw new Error("Invalid page encoding"); return value }
  const decodeReference = (input: unknown): Reference<Key> => {
    const data = array(input), count = positive("stored count", Number(data[1])), height = positive("stored height", Number(data[2])), width = positive("stored width", Number(data[3]))
    if (data.length !== 5 || data[4] !== null && typeof data[4] !== "string") throw new Error("Invalid reference encoding")
    return Object.freeze({ type: "stored", id: id(data[0]), count, height, width, last: count ? data[4] as Key : undefined })
  }
  const decodeValue = (input: unknown): Value => {
    if (input === null || typeof input === "boolean" || typeof input === "string" || typeof input === "number" && Number.isFinite(input)) return input
    const data = array(input)
    if (data[0] === "field" && data.length === 3) return Object.freeze({ type: "field", order: positive("field order", Number(data[1])), value: decodeValue(data[2]) })
    if (data.length !== (data[0] === "object" ? 3 : 2)) throw new Error("Invalid value encoding")
    if (data[0] === "text") return Object.freeze({ type: "text", id: id(data[1]) })
    if (data[0] !== "object" && data[0] !== "array") throw new Error("Invalid value type")
    return Object.freeze({ type: data[0], root: decodeReference(data[1]), ...(data[0] === "object" ? { next: positive("field sequence", Number(data[2])) } : {}) })
  }
  const decodePage = (input: unknown): Page<Key, Value> => {
    const data = array(input), items = array(data[1])
    if (data.length !== 2) throw new Error("Invalid page encoding")
    if (data[0] === "leaf") {
      const entries = Object.freeze(items.map(item => {
        const pair = array(item)
        if (pair.length !== 2 || pair[0] !== null && typeof pair[0] !== "string") throw new Error("Invalid page key")
        return Object.freeze([pair[0] as Key, decodeValue(pair[1])] as const)
      }))
      return Object.freeze({ type: "leaf", entries, count: entries.length, width: entries.length, height: 0, last: entries.at(-1)?.[0] })
    }
    if (data[0] !== "branch" || !items.length) throw new Error("Invalid branch encoding")
    const children = Object.freeze(items.map(decodeReference))
    return Object.freeze({ type: "branch", children, count: children.reduce((n, child) => n + child.count, 0), height: children[0]!.height + 1, width: children.length, last: children.at(-1)!.last })
  }
  const load = (recordId: number, kind: "page" | "text"): Page<Key, Value> | string => {
    const hit = cache.get(recordId)
    if (hit) {
      if (hit.kind !== kind) throw new Error("Stored record kind differs")
      cache.delete(recordId); cache.set(recordId, hit); counters.cacheHits++; return hit.value
    }
    const row = query("SELECT kind,payload,chunk_count,byte_length,digest FROM grove_pages WHERE id=?", [recordId])[0]
    if (!row || row.kind !== kind) throw new Error(`Missing ${kind} ${recordId}`)
    const chunks = row.payload === null ? driver.execute("SELECT ordinal,payload FROM grove_page_chunks WHERE id=? ORDER BY ordinal", [recordId]) : []
    if (row.payload === null && (chunks.length !== Number(row.chunk_count) || chunks.some((row, index) => row.ordinal !== index))) throw new Error("Missing or invalid page chunks")
    const payload = row.payload === null ? Buffer.concat(chunks.map(row => row.payload instanceof Uint8Array ? row.payload : row.payload instanceof ArrayBuffer ? new Uint8Array(row.payload) : Buffer.from(String(row.payload)))).toString("utf8") : String(row.payload)
    const bytes = Buffer.byteLength(payload)
    if (bytes !== Number(row.byte_length) || digest(payload) !== row.digest) throw new Error("Stored page bytes differ")
    const parsed: unknown = JSON.parse(payload)
    const value = kind === "page" ? decodePage(parsed) : parsed
    if (typeof value !== "string" && (kind === "text" || value === null || typeof value !== "object")) throw new Error("Invalid text encoding")
    counters.reads++; counters.readBytes += bytes
    if (bytes <= config.cacheBytes) {
      while (cachedBytes + bytes > config.cacheBytes) { const first = cache.keys().next().value!; cachedBytes -= cache.get(first)!.bytes; cache.delete(first); counters.evictions++ }
      cache.set(recordId, { kind, value: value as Page<Key, Value> | string, bytes }); cachedBytes += bytes
    }
    return value as Page<Key, Value> | string
  }
  const wireReference = (node: Node<Key, Value>, save: (node: Node<Key, Value>) => Reference<Key>): Json => {
    const ref = save(node)
    return [ref.id, ref.count, ref.height, ref.width, ref.last ?? null]
  }
  const wireValue = (value: Value, page: (node: Node<Key, Value>) => Reference<Key>, text: (value: Text) => number): Json => {
    if (value === null || typeof value !== "object") return value
    if (value.type === "field") return ["field", value.order, wireValue(value.value, page, text)]
    return value.type === "text" ? ["text", text(value)] : value.type === "object" ? [value.type, wireReference(value.root, page), value.next!] : [value.type, wireReference(value.root, page)]
  }
  const wirePage = (page: Page<Key, Value>, save: (node: Node<Key, Value>) => Reference<Key>, text: (value: Text) => number): Json =>
    page.type === "leaf" ? ["leaf", page.entries.map(([key, value]) => [key, wireValue(value, save, text)])] : ["branch", page.children.map(child => wireReference(child, save))]
  const placeholder = (node: Node<Key, Value>): Reference<Key> => node.type === "stored" ? node : reference(node, 1)
  const engine = documents({
    capacity: config.capacity, inlineBytes: config.inlineBytes,
    loadPage: id => load(id, "page") as Page<Key, Value>, loadText: id => load(id, "text") as string,
    allocated: page => { counters.allocatedPages++; counters.allocatedBytes += Buffer.byteLength(JSON.stringify(wirePage(page, placeholder, () => 1))) },
    allocatedText: value => { if ("value" in value) counters.allocatedBytes += Buffer.byteLength(JSON.stringify(value.value)) },
    materialized: () => { counters.materializations++ },
    equivalent: (value, previous) => {
      if (value === null || previous === null || typeof value !== "object" || typeof previous !== "object" || value.type !== previous.type || value.type !== "array" && value.type !== "object" || previous.type !== "array" && previous.type !== "object" || value.next !== previous.next) return false
      if (value.root === previous.root) return true
      const identity = (node: Node<Key, Value>) => {
        if (node.type === "stored") return node.id
        const context = coordinator.active(), saved = (context ? pending.get(context)?.get(node) : undefined) ?? identities.get(node)
        return typeof saved === "object" ? saved.id : undefined
      }
      const before = identity(previous.root)
      return before !== undefined && before === identity(value.root)
    },
  })
  const dependencies = (kind: string, payload: Json): number[] => {
    if (kind !== "page" || !Array.isArray(payload)) return []
    const items = payload[1] as readonly Json[]
    if (payload[0] === "branch") return items.map(item => Number((item as readonly Json[])[0]))
    return items.flatMap(item => {
      let value = (item as readonly Json[])[1]
      if (Array.isArray(value) && value[0] === "field") value = value[2]
      if (!Array.isArray(value)) return []
      return [Number(value[0] === "text" ? value[1] : (value[1] as readonly Json[])[0])]
    })
  }
  const write = (kind: string, payload: string) => {
    const chunks = textChunks(payload, config.chunkBytes), inline = chunks.length <= 1
    const row = query("INSERT INTO grove_pages(kind,payload,chunk_count,children,byte_length,digest) SELECT ?,?,?,json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]') FROM json_each(?) RETURNING id", [kind, inline ? payload : null, inline ? 0 : chunks.length, JSON.stringify([[JSON.stringify(dependencies(kind, JSON.parse(payload) as Json)), Buffer.byteLength(payload), digest(payload)]])])[0]!
    const id = Number(row.id)
    if (!inline) chunks.forEach((chunk, ordinal) => query("INSERT INTO grove_page_chunks VALUES(?,?,?)", [id, ordinal, chunk]))
    counters.writes++; counters.writtenBytes += Buffer.byteLength(payload)
    return id
  }
  const saveText = (current: Map<object, Reference<Key> | number>, value: Text): number => {
    if ("id" in value) return value.id
    const known = current.get(value) ?? identities.get(value)
    if (typeof known === "number") return known
    const result = write("text", JSON.stringify(value.value)); current.set(value, result); return result
  }
  const savePage = (current: Map<object, Reference<Key> | number>, node: Node<Key, Value>): Reference<Key> => {
    if (node.type === "stored") return node
    const known = current.get(node) ?? identities.get(node)
    if (known !== undefined && typeof known !== "number") return known
    const payload = JSON.stringify(wirePage(node, node => savePage(current, node), value => saveText(current, value)))
    const result = reference(node, write("page", payload)); current.set(node, result); return result
  }
  const encode = (current: Map<object, Reference<Key> | number>, value: Value) => wireValue(value, node => savePage(current, node), value => saveText(current, value))
  const clear = () => { cache.clear(); cachedBytes = 0; engine.forget() }
  const pending = new WeakMap<object, Map<object, Reference<Key> | number>>()
  const persist = (tx: Transaction, value: Value): Json => {
    const context = coordinator.guard(tx)
    let saved = pending.get(context)
    if (!saved) {
      saved = new Map(); pending.set(context, saved)
      context.rollback.add(clear)
      context.committed.push(() => { for (const [object, value] of saved!) identities.set(object, value) })
    }
    return encode(saved, value)
  }
  return {
    ...engine, persist, decode: decodeValue, clear, config,
    collect: (tx: Transaction, roots: readonly Json[]) => {
      coordinator.guard(tx)
      query(`WITH RECURSIVE roots(value) AS (SELECT value FROM json_each(?) WHERE type='array'), live(id) AS (
        SELECT CASE json_extract(value,'$[0]') WHEN 'object' THEN json_extract(value,'$[1][0]') WHEN 'array' THEN json_extract(value,'$[1][0]') WHEN 'text' THEN json_extract(value,'$[1]') END FROM roots
        UNION SELECT e.value FROM live JOIN grove_pages p ON p.id=live.id JOIN json_each(p.children) e
      ) DELETE FROM grove_pages WHERE id NOT IN (SELECT id FROM live WHERE id IS NOT NULL)`, [JSON.stringify(roots)])
      query("DELETE FROM grove_page_chunks WHERE id NOT IN (SELECT id FROM grove_pages)")
      coordinator.guard(tx).committed.push(() => { identities = new WeakMap(); clear() })
    },
    stats: () => ({ ...counters, ...config, cachedBytes, cachedRecords: cache.size }),
  }
}
