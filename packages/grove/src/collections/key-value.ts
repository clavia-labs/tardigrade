import { FORMAT_VERSION, bytes, digest, payload, freezeJson, type Json, type Node } from "../storage/nodes"
import type { ReadCache } from "../session/cache"
import { memoryMaps } from "../storage/memory/key-value"

export type MapSpan = readonly [branch: string, revision: number]
export interface MapEntry { readonly branch: string; readonly key: string; readonly revision: number; readonly order: number; readonly bytes: number; readonly deleted: boolean }
export interface MapStorage {
  readonly manifest: (hash: string) => readonly MapSpan[] | undefined
  readonly head: (branch: string) => number
  readonly entry: (branch: string, revision: number, key: string) => MapEntry | undefined
  readonly entries: (branch: string, revision: number, after: string | undefined, limit: number) => readonly MapEntry[]
  readonly value: (entry: MapEntry) => string
}
export interface MapChange { readonly text: string | null; readonly order: number }
interface Version { readonly hash: string; readonly text: string; readonly count: number; readonly logicalBytes: number }
export interface MapWrite { readonly node: Version; readonly parent?: Version; readonly changes: ReadonlyMap<string, MapChange> }
export interface MapBatch { readonly writes: readonly MapWrite[] }
export interface MapWriter extends MapStorage {
  readonly insert: (branch: string, revision: number, key: string, change: MapChange) => boolean
  readonly publish: (hash: string, spans: readonly MapSpan[]) => void
}

// commitMaps places immutable revisions without making logical references depend on which speculative branch committed first (test/mvcc.ts).
export function commitMaps(storage: MapWriter, batch: MapBatch) {
  let rows = 0, writtenBytes = 0
  for (const write of batch.writes) {
    if (storage.manifest(write.node.hash) !== undefined) continue
    const previous = write.parent ? storage.manifest(write.parent.hash) : []
    if (!previous) throw new Error("Missing parent key-value version")
    const last = previous.at(-1), extend = last !== undefined && storage.head(last[0]) === last[1]
    const branch = extend ? last![0] : write.node.hash, revision = extend ? last![1] + 1 : 1
    if (!Number.isSafeInteger(revision)) throw new Error("Key-value revision exceeds safe integer precision")
    for (const [key, change] of write.changes) if (storage.insert(branch, revision, key, change)) { rows++; writtenBytes += change.text === null ? 0 : bytes(change.text) }
    const spans: readonly MapSpan[] = !write.changes.size ? [] : extend ? [...previous.slice(0, -1), [branch, revision]] : [...previous, [branch, revision]]
    storage.publish(write.node.hash, spans)
  }
  return { rows, bytes: writtenBytes }
}


const logical = (node: Node) => payload(node) as readonly [string, number, number, number]
const build = (id: string, count: number, logicalBytes: number, order: number): Node => {
  const text = JSON.stringify([FORMAT_VERSION, "m", [id, count, logicalBytes, order]])
  return Object.freeze({ hash: digest(text), text, tag: "m", count, logicalBytes, level: 0, links: Object.freeze([]), children: Object.freeze([]) })
}

// makeMaps resolves keys through version branch manifests and shares the reader's encoded-byte cache (test/mvcc.ts; test/collections.test.ts).
export function makeMaps(backend: MapStorage | undefined, cache: ReadCache, batchItems: number) {
  const memory = backend ? undefined : memoryMaps(), storage = backend ?? memory!
  const pending = new Map<string, MapWrite>()
  let loadedMapValues = 0, loadedMapBytes = 0
  const manifest = (node: Version): readonly MapSpan[] => {
    const cached = cache.get<readonly MapSpan[]>("mm:" + node.hash)
    if (cached) return cached
    const spans = storage.manifest(node.hash)
    if (!spans || spans.some(span => !Array.isArray(span) || span.length !== 2 || typeof span[0] !== "string" || !/^[a-f0-9]{64}$/.test(span[0]) || !Number.isSafeInteger(span[1]) || span[1] < 1) || (node.count === 0) !== (spans.length === 0)) throw new Error("Invalid or missing key-value manifest")
    cache.set("mm:" + node.hash, spans, bytes(JSON.stringify(spans)))
    return spans
  }
  type Source = { readonly change: MapChange } | { readonly entry: MapEntry }
  const lookup = (node: Version, key: string): Source | undefined => {
    for (;;) {
      const write = pending.get(node.hash)
      if (write) {
        const change = write.changes.get(key)
        if (change) return change.text === null ? undefined : { change }
        if (!write.parent) return undefined
        node = write.parent
        continue
      }
      const name = "me:" + node.hash + ":" + JSON.stringify(key), cached = cache.get<{ readonly entry?: MapEntry }>(name)
      if (cached) return cached.entry ? { entry: cached.entry } : undefined
      const spans = manifest(node)
      let entry: MapEntry | undefined
      for (let index = spans.length - 1; index >= 0; index--) {
        const [branch, revision] = spans[index]!
        const found = storage.entry(branch, revision, key)
        if (found) { if (!found.deleted) entry = found; break }
      }
      const result = entry ? { entry } : {}
      cache.set(name, result, bytes(name) + bytes(JSON.stringify(result)))
      return entry ? { entry } : undefined
    }
  }
  const value = (source: Source): Json => {
    if ("change" in source) return freezeJson(JSON.parse(source.change.text!))
    const entry = source.entry, name = "mv:" + JSON.stringify([entry.branch, entry.key, entry.revision])
    const cached = cache.get<{ readonly value: Json }>(name)
    if (cached) return cached.value
    const text = storage.value(entry), value = freezeJson(JSON.parse(text))
    if (bytes(text) !== entry.bytes) throw new Error("Key-value length mismatch")
    loadedMapValues++; loadedMapBytes += entry.bytes
    cache.set(name, { value }, entry.bytes + bytes(name))
    return value
  }
  const stage = (node: Node, changes: ReadonlyMap<string, MapChange>, parent?: Node) => {
    if (!pending.has(node.hash)) pending.set(node.hash, Object.freeze({ node, changes, ...(parent ? { parent } : {}) }))
    return node
  }
  const create = (values: Readonly<Record<string, Json>>) => {
    const changes = new Map<string, MapChange>(), entries = Object.entries(values)
    let size = 2
    for (const [key, value] of entries) { const text = JSON.stringify(value); size += bytes(JSON.stringify(key)) + 1 + bytes(text) + Number(changes.size > 0); changes.set(key, { text, order: changes.size + 1 }) }
    const id = digest(JSON.stringify(["map", [...changes].map(([key, change]) => [key, change.text])]))
    return stage(build(id, changes.size, size, changes.size), changes)
  }
  const snapshot = (nodes: Iterable<Node>): MapBatch => {
    const writes: MapWrite[] = [], seen = new Set<string>()
    const visit = (node: Version) => {
      if (seen.has(node.hash)) return
      seen.add(node.hash)
      const write = pending.get(node.hash)
      if (!write) return
      if (write.parent) visit(write.parent)
      writes.push(write)
    }
    for (const node of nodes) if (node.tag === "m") visit(node)
    return Object.freeze({ writes: Object.freeze(writes) })
  }
  return {
    create,
    change: (current: Node, key: string, next: Json | undefined) => {
      const previous = lookup(current, key)
      if (!previous && next === undefined) return current
      const oldBytes = previous ? "change" in previous ? bytes(previous.change.text!) : previous.entry.bytes : 0
      const [id, , , order] = logical(current), text = next === undefined ? null : JSON.stringify(next)
      const count = current.count + Number(!previous) - Number(text === null)
      if (count === 0) return create({})
      const nextOrder = previous ? "change" in previous ? previous.change.order : previous.entry.order : order + 1
      const size = current.logicalBytes + (text === null ? -oldBytes - bytes(JSON.stringify(key)) - 2 : previous ? bytes(text) - oldBytes : bytes(JSON.stringify(key)) + 1 + bytes(text) + Number(current.count > 0))
      if (![count, size, nextOrder].every(Number.isSafeInteger)) throw new Error("Key-value metadata exceeds safe integer precision")
      return stage(build(digest(JSON.stringify(["map-edit", id, key, text])), count, size, Math.max(order, nextOrder)), new Map([[key, { text, order: nextOrder }]]), current)
    },
    has: (node: Node, key: string) => lookup(node, key) !== undefined,
    read: (node: Node, key: string) => { const source = lookup(node, key); if (!source) throw new Error("Invalid object path"); return value(source) },
    materialize: (node: Node): Json => {
      const found = new Map<string, Source | undefined>()
      let cursor: Version = node
      for (;;) {
        const write = pending.get(cursor.hash)
        if (write) {
          for (const [key, change] of write.changes) if (!found.has(key)) found.set(key, change.text === null ? undefined : { change })
          if (!write.parent) break
          cursor = write.parent
          continue
        }
        const spans = manifest(cursor)
        for (let index = spans.length - 1; index >= 0; index--) {
          const [branch, revision] = spans[index]!
          let after: string | undefined
          for (;;) {
            const entries = storage.entries(branch, revision, after, batchItems)
            for (const entry of entries) if (!found.has(entry.key)) found.set(entry.key, entry.deleted ? undefined : { entry })
            if (entries.length < batchItems) break
            const last = entries.at(-1)!.key
            if (after !== undefined && last === after) throw new Error("Invalid key-value page order")
            after = last
          }
        }
        break
      }
      const entries = [...found].flatMap(([key, source]) => source ? [{ key, source, order: "change" in source ? source.change.order : source.entry.order, size: "change" in source ? bytes(source.change.text!) : source.entry.bytes }] : [])
      const order = logical(node)[3], size = 2 + Math.max(0, entries.length - 1) + entries.reduce((sum, entry) => sum + bytes(JSON.stringify(entry.key)) + 1 + entry.size, 0)
      if (entries.length !== node.count || size !== node.logicalBytes || new Set(entries.map(entry => entry.order)).size !== entries.length || entries.some(entry => entry.order > order)) throw new Error("Key-value version metadata mismatch")
      return Object.fromEntries(entries.sort((a, b) => a.order - b.order).map(entry => [entry.key, value(entry.source)]))
    },
    snapshot,
    acknowledge: (batch: MapBatch) => { if (memory) commitMaps(memory, batch); for (const write of batch.writes) if (pending.get(write.node.hash) === write) pending.delete(write.node.hash) },
    discard: (nodes: Iterable<Node>) => { const keep = new Set(snapshot(nodes).writes.map(write => write.node.hash)); for (const hash of pending.keys()) if (!keep.has(hash)) pending.delete(hash) },
    stats: () => ({ loadedMapValues, loadedMapBytes, stagedMapEntries: [...pending.values()].reduce((sum, write) => sum + write.changes.size, 0) }),
  }
}
export type Maps = ReturnType<typeof makeMaps>
