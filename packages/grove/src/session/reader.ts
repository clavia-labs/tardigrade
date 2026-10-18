import type { Maps } from "../collections/key-value"
import type { Logs } from "../collections/append-only"
import { makeCache, DEFAULT_READ_CACHE_BYTES, type ReadCache } from "./cache"
export { DEFAULT_READ_CACHE_BYTES } from "./cache"
import { keyedEntries, keyedIndex } from "../collections/tree-keys"
import { make, type Edit } from "../collections/tree"
import { decodeNode, matchNode, mergeablePages, plan, payload, type Json, type Path, type Options, type Node, type Tree, DEFAULT_LEAF_BYTES, DEFAULT_PAGE_ITEMS } from "../storage/nodes"

type Selection = { readonly node: Node } | { readonly value: Json }
export class GroveError extends Error {
  readonly _tag = "GroveError"
  constructor(options: { readonly message: string; readonly cause?: unknown }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "GroveError"
  }
  static from(cause: unknown): GroveError { return cause instanceof GroveError ? cause : new GroveError({ message: cause instanceof Error ? cause.message : String(cause), cause }) }
}
const attempt = <Value>(work: () => Value): Value => {
  try { return work() } catch (cause) { throw GroveError.from(cause) }
}
const error = (message: string): never => { throw new GroveError({ message }) }
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const withLinks = (node: Node, links: readonly Node[]): Node => Object.freeze({ ...node, links: Object.freeze(links) })

export interface ReaderOptions extends Options { readonly cacheBytes?: number; readonly rowBatchItems?: number }

export function makeReader(load: (hash: string) => string, options: ReaderOptions = {}, sharedCache?: ReadCache, logs?: Logs, maps?: Maps) {
  const cacheBytes = options.cacheBytes ?? DEFAULT_READ_CACHE_BYTES
  if (!natural(cacheBytes)) throw new Error("Invalid Merkle read cache budget")
  const tree = make(options, { memo: false, ...(logs ? { logs } : {}), ...(maps ? { maps } : {}) })
  const cache = sharedCache ?? makeCache(cacheBytes)
  const metrics = { loadedNodes: 0, loadedBytes: 0, hits: 0, evictions: 0 }
  const readNode = (ref: string | Node): Node => {
    if (typeof ref !== "string" && !ref.opaque) return ref
    const hash = typeof ref === "string" ? ref : ref.hash
    const cached = cache.get<Node>(hash)
    if (cached) {
      return typeof ref === "string" ? cached : matchNode(ref, cached)
    }
    const text = load(hash)
    if (typeof text !== "string") return error("Grove node reads must complete synchronously with encoded text")
    const node = decodeNode(hash, text)
    if (typeof ref !== "string") matchNode(ref, node)
    const bytes = Buffer.byteLength(text)
    metrics.loadedNodes++; metrics.loadedBytes += bytes
    cache.set(hash, node, bytes)
    return node
  }
  const jsonPath = (value: Json, path: Path): Json => {
    for (const key of path) {
      if (Array.isArray(value)) {
        if (typeof key !== "number" || !natural(key) || key >= value.length) throw new Error("Invalid array path")
        value = value[key]!
      } else {
        if (value === null || typeof value !== "object" || typeof key !== "string" || !Object.hasOwn(value, key)) throw new Error("Invalid object path")
        value = (value as Record<string, Json>)[key]!
      }
    }
    return value
  }
  const cachedChild = (ref: Node): Node | undefined => {
    const entry = cache.get<Node>(ref.hash)
    if (entry === undefined) return undefined
    matchNode(ref, entry)
    return entry
  }
  // cachedValue materializes node from decoded cache entries alone, returning undefined when any descendant needs a load.
  const cachedValue = (node: Node): Json | undefined => {
    if (node.tag === "l" || node.tag === "m") return undefined
    if (node.tag === "v" || node.tag === "p") return payload(node)
    if (node.tag === "k" || node.tag === "b") return undefined
    const values: Json[] = []
    for (const link of node.links) {
      const child = cachedChild(link)
      const value = child && cachedValue(child)
      if (value === undefined) return undefined
      values.push(value)
    }
    switch (node.tag) {
      case "a": return values[0]!
      case "r": return values
      case "c": return values.flat() as Json
      case "o": return Object.fromEntries(values.map((value, index) => [(payload(node) as readonly (readonly [string, unknown])[])[index]![0], value]))
    }
  }
  const materialize = (node: Node): Json => {
    const cached = cachedValue(node)
    return cached === undefined ? loadValue(node) : cached
  }
  const ordered = (node: Node): readonly (readonly [string, number, Json])[] => node.tag === "k"
    ? keyedEntries(node).map(([key, order, child]) => [key, order, materialize(readNode(child))] as const)
    : node.links.flatMap(child => ordered(readNode(child)))
  const loadValue = (node: Node): Json => {
    switch (node.tag) {
      case "m": if (!maps) return error("Key-value storage is unavailable"); return maps.materialize(node)
      case "l": if (!logs) return error("Log rows are unavailable"); return logs.read(node, 0, node.count)
      case "k": case "b": return Object.fromEntries(ordered(node).toSorted((a, b) => a[1] - b[1]).map(([key, , value]) => [key, value]))
      case "v": case "p": return payload(node)
      case "a": return materialize(readNode(node.links[0]!))
      case "r": return node.links.map(child => materialize(readNode(child)))
      case "c": return node.links.flatMap(child => materialize(readNode(child)) as readonly Json[])
      case "o": return Object.fromEntries(node.links.map((child, index) => [(payload(node) as readonly (readonly [string, unknown])[])[index]![0], materialize(readNode(child))]))
    }
  }
  const at = (ref: string | Node, path: Path): Selection => {
    const node = readNode(ref)
    if (!path.length) return { node }
    const [key, ...tail] = path
    if (node.tag === "m") {
      if (!maps || typeof key !== "string") return error("Invalid key-value path")
      return { value: jsonPath(maps.read(node, key), tail) }
    }
    if (node.tag === "l") {
      if (!logs || typeof key !== "number" || !natural(key) || key >= node.count) return error("Invalid log array path")
      return { value: jsonPath(logs.read(node, key, key + 1)[0]!, tail) }
    }
    if (node.tag === "v" || node.tag === "p") return { value: jsonPath(payload(node), path) }
    if (node.tag === "k") {
      if (typeof key !== "string") return error("Invalid object path")
      const entry = keyedEntries(node).find(([name]) => name === key)
      return entry ? at(entry[2], tail) : error("Invalid object path")
    }
    if (node.tag === "b") {
      if (typeof key !== "string") return error("Invalid object path")
      return at(node.links[keyedIndex(node, key)]!, path)
    }
    if (node.tag === "o") {
      const index = (payload(node) as [string, unknown][]).findIndex(([name]) => name === key)
      return index < 0 ? error("Invalid object path") : at(node.links[index]!, tail)
    }
    if (typeof key !== "number" || !natural(key)) return error("Invalid array path")
    if (node.tag === "a") return key < node.count ? at(node.links[0]!, path) : error("Invalid array path")
    if (node.tag === "r") return key < node.count ? at(node.links[key]!, tail) : error("Invalid array path")
    let offset = key
    for (const child of node.links) {
      if (offset < child.count) return at(child, [offset, ...tail])
      offset -= child.count
    }
    return error("Invalid array path")
  }
  const hasChild = (node: Node, key: string | number): boolean => {
    if (node.tag === "m") { if (!maps || typeof key !== "string") return error("Invalid key-value path"); return maps.has(node, key) }
    if (node.tag === "k") return typeof key === "string" && keyedEntries(node).some(([name]) => name === key)
    if (node.tag === "b") return typeof key === "string" && hasChild(readNode(node.links[keyedIndex(node, key)]!), key)
    if (node.tag === "o") return typeof key === "string" && (payload(node) as [string, unknown][]).some(([name]) => name === key)
    if (node.tag !== "v" && node.tag !== "p") return typeof key === "number" && natural(key) && key < node.count
    const value = payload(node)
    return value !== null && typeof value === "object" && Object.hasOwn(value, key)
  }
  const size = (node: Node): number | undefined => node.tag === "v" ? Array.isArray(payload(node)) ? (payload(node) as readonly Json[]).length : undefined : (node.tag === "o" || node.tag === "k" || node.tag === "b" || node.tag === "m") ? undefined : node.count
  const range = (node: Node, start: number, end: number): readonly Json[] => {
    if (start === end) return []
    if (node.tag === "l") { if (!logs) return error("Log rows are unavailable"); return logs.read(node, start, end) }
    if (node.tag === "v" || node.tag === "p") return (payload(node) as readonly Json[]).slice(start, end)
    if (node.tag === "a") return range(readNode(node.links[0]!), start, end)
    if (node.tag === "r") return node.links.slice(start, end).map(child => materialize(readNode(child)))
    const values: Json[] = []
    let offset = 0
    for (const child of node.links) {
      if (offset >= end) break
      if (offset + child.count > start) values.push(...range(readNode(child), Math.max(0, start - offset), Math.min(child.count, end - offset)))
      offset += child.count
    }
    return values
  }
  const tail = (ref: Node): Node => {
    const node = readNode(ref)
    if (node.tag !== "c") return node
    const links = [...node.links]
    const previous = links.at(-2)
    if (node.level === 1 && previous && mergeablePages(previous, links.at(-1)!, options.pageItems ?? DEFAULT_PAGE_ITEMS, options.leafBytes ?? DEFAULT_LEAF_BYTES)) links[links.length - 2] = readNode(previous)
    links[links.length - 1] = tail(links.at(-1)!)
    return withLinks(node, links)
  }
  type Preparation = "set" | "append" | "remove" | "entry" | { readonly start: number; readonly end: number }
  const spliceBoundary = (ref: Node, indices: readonly number[]): Node => {
    const node = readNode(ref)
    if (node.tag !== "c") return node
    let offset = 0
    const links: Node[] = []
    for (const child of node.links) {
      const selected = indices.filter(index => index >= offset && index < offset + child.count).map(index => index - offset)
      links.push(selected.length ? spliceBoundary(child, selected) : child)
      offset += child.count
    }
    return withLinks(node, links)
  }
  const segment = (ref: Node, index: number, path: Path, operation: Preparation): Node => {
    const node = readNode(ref)
    if (node.tag === "p") return node
    const links = [...node.links]
    if (node.tag === "r") links[index] = prepare(links[index]!, path, operation)
    else {
      let offset = index
      const i = links.findIndex(child => { if (offset < child.count) return true; offset -= child.count; return false })
      if (i < 0) return error("Invalid array path")
      links[i] = segment(links[i]!, offset, path, operation)
    }
    return withLinks(node, links)
  }
  const prepare = (ref: string | Node, path: Path, operation: Preparation): Node => {
    if (operation === "set" && !path.length && typeof ref !== "string") return ref
    const node = readNode(ref)
    if (node.tag === "v") return node
    if (!path.length) {
      if (node.tag !== "a") return node
      if (operation === "append") return withLinks(node, [tail(node.links[0]!)])
      if (typeof operation === "object") {
        if (!natural(operation.start) || !natural(operation.end) || operation.start > operation.end || operation.end > node.count) return error("Invalid splice bounds")
        const indices: number[] = []
        if (operation.start > 0) indices.push(operation.start - 1)
        if (operation.end < node.count) indices.push(operation.end)
        return withLinks(node, [spliceBoundary(node.links[0]!, indices)])
      }
      return node
    }
    const [key, ...rest] = path
    const links = [...node.links]
    if (node.tag === "a") {
      if (typeof key !== "number" || !natural(key) || key >= node.count) return error("Invalid array path")
      return withLinks(node, [segment(links[0]!, key, rest, operation)])
    }
    if (node.tag === "k" || node.tag === "b") {
      if (typeof key !== "string") return error("Invalid object path")
      if (node.tag === "k") {
        const index = keyedEntries(node).findIndex(([name]) => name === key)
        if (index >= 0 && !(operation === "remove" && !rest.length)) links[index] = prepare(links[index]!, rest, operation)
      } else {
        const index = keyedIndex(node, key)
        links[index] = prepare(links[index]!, path, operation)
        if (operation === "remove" && !rest.length && links.length > 1) {
          const neighbor = index > 0 ? index - 1 : 1
          links[neighbor] = readNode(links[neighbor]!)
        }
      }
      return withLinks(node, links)
    }
    if (node.tag !== "o" || typeof key !== "string") return error("Invalid object path")
    const index = (payload(node) as [string, unknown][]).findIndex(([name]) => name === key)
    if (index >= 0 && !(operation === "remove" && !rest.length)) links[index] = prepare(links[index]!, rest, operation)
    return withLinks(node, links)
  }
  // superseded evicts the loaded path an edit replaced, since each edit decodes a new version of the same content; a later read of the old root reloads it.
  const superseded = (before: Node, after: Tree): Tree => {
    const kept = new Set<string>()
    const keep = (node: Node) => { if (kept.has(node.hash)) return; kept.add(node.hash); for (const link of node.links) keep(link) }
    keep(after.node)
    const drop = (node: Node) => {
      if (node.opaque || kept.has(node.hash)) return
      cache.remove(node.hash)
      for (const link of node.links) drop(link)
    }
    drop(before)
    return after
  }
  const readFrom = (source: string | Node, path: Path): Json => {
    const selected = at(source, path)
    return "value" in selected ? selected.value : materialize(selected.node)
  }
  const slice = (root: string, path: Path, start: number, end: number): readonly Json[] => attempt(() => {
    const selected = at(root, path)
    if (!natural(start) || !natural(end) || start > end) return error("Invalid Merkle range")
    if ("value" in selected) return Array.isArray(selected.value) ? selected.value.slice(start, end) : error("Range target must be an array")
    const n = size(selected.node)
    return n === undefined ? error("Range target must be an array") : range(selected.node, Math.min(start, n), Math.min(end, n))
  })
  const scanNode = function* (source: Node, start: number, end: number, each: Path): IterableIterator<Json> {
    const node = readNode(source)
    if (node.tag === "l") {
      if (!logs) return error("Log rows are unavailable")
      for (const value of logs.scan(node, start, end)) yield jsonPath(value, each)
    } else if (node.tag === "v" || node.tag === "p") {
      const items = payload(node)
      if (!Array.isArray(items)) return error("Scan target must be an array")
      for (let index = start; index < end; index++) yield jsonPath(items[index]!, each)
    } else if (node.tag === "a") yield* scanNode(node.links[0]!, start, end, each)
    else if (node.tag === "r") {
      for (let index = start; index < end; index++) yield readFrom(node.links[index]!, each)
    } else if (node.tag === "c") {
      let offset = 0
      for (const child of node.links) {
        if (offset >= end) break
        if (offset + child.count > start) yield* scanNode(child, Math.max(0, start - offset), Math.min(child.count, end - offset), each)
        offset += child.count
      }
    } else return error("Scan target must be an array")
  }
  // scan streams a bounded array range and closes nested iterators when consumption stops (test/references.test.ts).
  const scan = function* (root: string, path: Path, requested?: { readonly start: number; readonly end: number }, each: Path = []): IterableIterator<Json> {
    try {
      const selected = at(root, path)
      const count = "value" in selected ? Array.isArray(selected.value) ? selected.value.length : undefined : size(selected.node)
      if (count === undefined) return error("Scan target must be an array")
      const start = requested?.start ?? 0, end = requested?.end ?? count
      if (!natural(start) || !natural(end) || start > end || end > count) throw new RangeError("Invalid scan range")
      if (start === end) return
      if ("value" in selected) {
        const items = selected.value as readonly Json[]
        for (let index = start; index < end; index++) yield jsonPath(items[index]!, each)
      } else yield* scanNode(selected.node, start, end, each)
    } catch (cause) { throw GroveError.from(cause) }
  }
  const metricsForEdit = () => ({ hashedNodes: 0, hashedBytes: 0, visitedValues: 0, reusedNodes: 0 })
  const edit = (root: string, path: Path, operation: Preparation, apply: (source: Tree) => Tree): Tree => attempt(() => {
    const node = prepare(root, path, operation)
    return superseded(node, apply(plan(node, metricsForEdit())))
  })
  return {
    scan,
    bytes: (root: string) => attempt(() => readNode(root).logicalBytes),
    read: (root: string, path: Path = []) => attempt(() => readFrom(root, path)),
    has: (root: string, path: Path) => attempt(() => {
      if (!path.length) return true
      const parent = at(root, path.slice(0, -1)), key = path.at(-1)!
      return "node" in parent ? hasChild(parent.node, key) : parent.value !== null && typeof parent.value === "object" && Object.hasOwn(parent.value, key)
    }),
    length: (root: string, path: Path = []) => attempt(() => {
      const selected = at(root, path)
      const n = "value" in selected ? Array.isArray(selected.value) ? selected.value.length : undefined : size(selected.node)
      return n === undefined ? error("Length target must be an array") : n
    }),
    slice,
    entry: (root: string, path: Path, key: string, value: Json | undefined) => edit(root, path, "entry", source => tree.entry(source, path, key, value)),
    set: (root: string, path: Path, value: Json) => edit(root, path, "set", source => tree.set(source, path, value)),
    append: (root: string, path: Path, values: readonly Json[]) => edit(root, path, "append", source => tree.append(source, path, values)),
    splice: (root: string, path: Path, index: number, deleteCount: number, values: readonly Json[] = []) => edit(root, path, { start: index, end: index + deleteCount }, source => tree.splice(source, path, index, deleteCount, values)),
    remove: (root: string, path: Path) => edit(root, path, "remove", source => tree.remove(source, path)),
    batch: (root: string, edits: readonly Edit[]): Tree => attempt(() => {
      let node = readNode(root)
      const metrics = metricsForEdit()
      let group: Edit[] = []
      const flush = () => {
        if (!group.length) return
        for (const edit of group) {
          const operation = edit.type === "splice" ? { start: edit.index, end: edit.index + edit.deleteCount } : edit.type
          node = prepare(node, edit.path, operation)
        }
        const changed = superseded(node, tree.batch(plan(node, metrics), group))
        for (const key of Object.keys(metrics) as (keyof typeof metrics)[]) metrics[key] += changed.metrics[key]
        node = changed.node; group = []
      }
      for (const edit of edits) {
        if (group.some(previous => previous.path.slice(0, Math.min(previous.path.length, edit.path.length)).every((key, index) => key === edit.path[index]))) flush()
        group.push(edit)
      }
      flush()
      return plan(node, metrics)
    }),
    stats: () => ({ ...metrics, ...cache.stats() }),
    clear: cache.clear,
    // evict removes decoded entries for discarded staged hashes (test/transactions.test.ts; test/collections/tree.test.ts).
    evict: (hashes: Iterable<string>) => {
      for (const hash of hashes) cache.remove(hash)
    },
  }
}
