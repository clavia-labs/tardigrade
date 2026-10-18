import { memoryRows } from "../storage/memory/append-only"
import { FORMAT_VERSION, digest, payload, freezeJson, bytes, type Json, type Node } from "../storage/nodes"
import type { ReadCache } from "../session/cache"

export const DEFAULT_ROW_BATCH_ITEMS = 64
export type LogSpan = readonly [log: string, end: number, bytes: number]
interface LogVersion { readonly hash: string; readonly text: string; readonly count: number; readonly logicalBytes: number }
export interface LogWrite { readonly node: LogVersion; readonly parent?: LogVersion; readonly texts: readonly string[] }

export interface RowStorage {
  readonly manifest: (hash: string) => readonly LogSpan[] | undefined
  readonly length: (log: string) => number
  readonly read: (log: string, start: number, end: number) => readonly string[]
}
export interface LogBatch { readonly writes: readonly LogWrite[] }
export interface RowWriter extends RowStorage {
  readonly insert: (log: string, index: number, text: string) => void
  readonly publish: (hash: string, spans: readonly LogSpan[]) => void
}

// commitLogs chooses physical prefixes at commit time while logical version identities stay independent of speculative placement (test/append-only.test.ts).
export function commitLogs(storage: RowWriter, batch: LogBatch): { readonly rows: number; readonly bytes: number } {
  let rows = 0, writtenBytes = 0
  for (const write of batch.writes) {
    if (storage.manifest(write.node.hash) !== undefined) continue
    const spans = write.parent ? storage.manifest(write.parent.hash) : []
    if (!spans) throw new Error("Missing parent log version")
    const size = write.texts.reduce((sum, text) => sum + bytes(text), 0), last = spans.at(-1)
    let log = write.node.hash, start = 0, overlap = 0, extend = false
    if (last) {
      const existing = Math.max(0, Math.min(storage.length(last[0]), last[1] + write.texts.length) - last[1])
      const texts = existing ? storage.read(last[0], last[1], last[1] + existing) : []
      if (texts.every((text, index) => text === write.texts[index])) { log = last[0]; start = last[1]; overlap = existing; extend = true }
    }
    for (let index = overlap; index < write.texts.length; index++) { storage.insert(log, start + index, write.texts[index]!); rows++; writtenBytes += bytes(write.texts[index]!) }
    const next: readonly LogSpan[] = !write.texts.length ? spans : extend ? [...spans.slice(0, -1), [log, start + write.texts.length, last![2] + size]] : [...spans, [log, write.texts.length, size]]
    storage.publish(write.node.hash, next)
  }
  return { rows, bytes: writtenBytes }
}


const version = (node: Node) => (payload(node) as readonly Json[])[0] as string
const build = (id: string, count: number, logicalBytes: number): Node => {
  const text = JSON.stringify([FORMAT_VERSION, "l", [id, count, logicalBytes]])
  return Object.freeze({ hash: digest(text), text, tag: "l", links: Object.freeze([]), children: Object.freeze([]), logicalBytes, count, level: 0 })
}

// makeLogs stores logical versions independently of their physical prefix placement so replay and speculative branches retain stable references (test/append-only.test.ts).
export function makeLogs(backend: RowStorage | undefined, cache: ReadCache, batchItems = DEFAULT_ROW_BATCH_ITEMS) {
  if (!Number.isSafeInteger(batchItems) || batchItems < 1) throw new Error("rowBatchItems must be a positive safe integer")
  const memory = backend ? undefined : memoryRows(), storage = backend ?? memory!
  const pending = new Map<string, LogWrite>()
  let loadedRows = 0, loadedRowBytes = 0
  const manifest = (node: LogVersion): readonly LogSpan[] => {
    const cached = cache.get<readonly LogSpan[]>("m:" + node.hash)
    if (cached) return cached
    const spans = storage.manifest(node.hash)
    if (!spans || spans.some(span => !Array.isArray(span) || span.length !== 3 || typeof span[0] !== "string" || !/^[a-f0-9]{64}$/.test(span[0]) || !Number.isSafeInteger(span[1]) || span[1] < 1 || !Number.isSafeInteger(span[2]) || span[2] < span[1]) || spans.reduce((sum, span) => sum + span[1], 0) !== node.count || 2 + spans.reduce((sum, span) => sum + span[2], 0) + Math.max(0, node.count - 1) !== node.logicalBytes) throw new Error("Invalid or missing log manifest")
    cache.set("m:" + node.hash, spans, bytes(JSON.stringify(spans)))
    return spans
  }
  interface RowPage { readonly values: (Json | undefined)[]; bytes: number }
  const page = (log: string, start: number, end: number): readonly Json[] => {
    const pageStart = Math.floor(start / batchItems) * batchItems, key = `r:${log}:${pageStart}`
    const entry = cache.get<RowPage>(key) ?? { values: [], bytes: 0 }
    const missing: number[] = []
    for (let index = start; index < end; index++) if (entry.values[index - pageStart] === undefined) missing.push(index)
    if (missing.length) {
      const from = missing[0]!, stop = missing.at(-1)! + 1
      const texts = storage.read(log, from, stop)
      if (texts.length !== stop - from) throw new Error("Missing append-only rows")
      for (let index = from; index < stop; index++) if (entry.values[index - pageStart] === undefined) {
        const text = texts[index - from]!
        entry.values[index - pageStart] = freezeJson(JSON.parse(text))
        entry.bytes += bytes(text); loadedRows++; loadedRowBytes += bytes(text)
      }
      cache.set(key, entry, entry.bytes)
    }
    return entry.values.slice(start - pageStart, end - pageStart) as readonly Json[]
  }
  const scan = function* (node: LogVersion, start: number, end: number): IterableIterator<Json> {
    const write = pending.get(node.hash)
    if (write) {
      const prefix = write.parent?.count ?? 0
      if (write.parent && start < prefix) yield* scan(write.parent, start, Math.min(end, prefix))
      for (let index = Math.max(start, prefix); index < end; index++) yield freezeJson(JSON.parse(write.texts[index - prefix]!))
      return
    }
    let offset = 0
    for (const [log, count] of manifest(node)) {
      const first = Math.max(start - offset, 0), stop = Math.min(end - offset, count)
      for (let index = first; index < stop;) {
        const next = Math.min(stop, (Math.floor(index / batchItems) + 1) * batchItems)
        yield* page(log, index, next)
        index = next
      }
      offset += count
      if (offset >= end) break
    }
  }
  const snapshot = (nodes: Iterable<Node>): LogBatch => {
    const writes: LogWrite[] = [], seen = new Set<string>()
    const visit = (node: LogVersion) => {
      if (seen.has(node.hash)) return
      seen.add(node.hash)
      const write = pending.get(node.hash)
      if (!write) return
      if (write.parent) visit(write.parent)
      writes.push(write)
    }
    for (const node of nodes) if (node.tag === "l") visit(node)
    return Object.freeze({ writes: Object.freeze(writes) })
  }
  const stage = (node: Node, texts: readonly string[], parent?: Node) => {
    if (!pending.has(node.hash)) pending.set(node.hash, Object.freeze({ node, texts: Object.freeze(texts), ...(parent ? { parent } : {}) }))
    return node
  }
  return {
    create: (values: readonly Json[], key: string) => {
      const texts = values.map(value => JSON.stringify(value)), size = texts.reduce((sum, text) => sum + bytes(text), 0)
      const id = digest(JSON.stringify(["log", key, texts])), node = build(id, texts.length, 2 + size + Math.max(0, texts.length - 1))
      return stage(node, texts)
    },
    append: (current: Node, values: readonly Json[]) => {
      if (!values.length) return current
      const texts = values.map(value => JSON.stringify(value)), size = texts.reduce((sum, text) => sum + bytes(text), 0)
      const id = digest(JSON.stringify(["append", version(current), texts]))
      const node = build(id, current.count + texts.length, current.logicalBytes + size + texts.length - Number(current.count === 0))
      return stage(node, texts, current)
    },
    scan,
    read: (node: Node, start: number, end: number) => [...scan(node, start, end)],
    snapshot,
    acknowledge: (batch: LogBatch) => {
      if (memory) commitLogs(memory, batch)
      for (const write of batch.writes) if (pending.get(write.node.hash) === write) pending.delete(write.node.hash)
    },
    discard: (nodes: Iterable<Node>) => {
      const retained = new Set(snapshot(nodes).writes.map(write => write.node.hash))
      for (const hash of pending.keys()) if (!retained.has(hash)) pending.delete(hash)
    },
    stats: () => ({ loadedRows, loadedRowBytes, stagedRows: [...pending.values()].reduce((sum, write) => sum + write.texts.length, 0), rowBatchItems: batchItems }),
  }
}
export type Logs = ReturnType<typeof makeLogs>
