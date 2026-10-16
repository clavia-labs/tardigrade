import { Data, Effect } from "effect"
import { make, type Edit } from "./tree"
import { decodeNode, matchNode, mergeablePages, plan, payload, type Json, type Path, type Options, type Node, type Tree, DEFAULT_LEAF_BYTES, DEFAULT_PAGE_ITEMS } from "./codec"

// DEFAULT_READ_CACHE_BYTES bounds encoded text rather than total heap usage.
export const DEFAULT_READ_CACHE_BYTES = 256 * 1024
type Selection = { readonly node: Node } | { readonly value: Json }
export class GroveError extends Data.TaggedError("GroveError")<{ readonly message: string; readonly cause?: unknown }> {
  static from(cause: unknown): GroveError { return cause instanceof GroveError ? cause : new GroveError({ message: cause instanceof Error ? cause.message : String(cause), cause }) }
}
const attempt = <A>(work: () => A) => Effect.try({ try: work, catch: GroveError.from })
const error = (message: string) => Effect.fail(new GroveError({ message }))
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const withLinks = (node: Node, links: readonly Node[]): Node => Object.freeze({ ...node, links: Object.freeze(links) })

export interface ReaderOptions extends Options { readonly cacheBytes?: number }

export function makeReader(load: (hash: string) => Effect.Effect<string, GroveError>, options: ReaderOptions = {}) {
  const cacheBytes = options.cacheBytes ?? DEFAULT_READ_CACHE_BYTES
  if (!natural(cacheBytes)) throw new Error("Invalid Merkle read cache budget")
  const tree = make(options, { memo: false })
  const cache = new Map<string, Node>()
  const sizes = new Map<string, number>()
  let cachedBytes = 0
  const metrics = { loadedNodes: 0, loadedBytes: 0, hits: 0, evictions: 0 }
  const readNode = (ref: string | Node): Effect.Effect<Node, GroveError> => Effect.suspend(() => {
    if (typeof ref !== "string" && !ref.opaque) return Effect.succeed(ref)
    const hash = typeof ref === "string" ? ref : ref.hash
    const check = (node: Node) => attempt(() => typeof ref === "string" ? node : matchNode(ref, node))
    const cached = cache.get(hash)
    if (cached) { cache.delete(hash); cache.set(hash, cached); metrics.hits++; return check(cached) }
    return load(hash).pipe(Effect.flatMap(text => attempt(() => {
      const node = decodeNode(hash, text)
      if (typeof ref !== "string") matchNode(ref, node)
      const bytes = Buffer.byteLength(text)
      metrics.loadedNodes++; metrics.loadedBytes += bytes
      if (bytes <= cacheBytes) {
        cachedBytes -= sizes.get(hash) ?? 0; cache.delete(hash); sizes.delete(hash)
        while (cache.size && cachedBytes + bytes > cacheBytes) {
          const first = cache.keys().next().value!
          cachedBytes -= sizes.get(first)!; cache.delete(first); sizes.delete(first); metrics.evictions++
        }
        cache.set(hash, node); sizes.set(hash, bytes); cachedBytes += bytes
      }
      return node
    })))
  })
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
    const entry = cache.get(ref.hash)
    if (entry === undefined) return undefined
    matchNode(ref, entry)
    cache.delete(ref.hash); cache.set(ref.hash, entry); metrics.hits++
    return entry
  }
  // cachedValue materializes node from decoded cache entries alone, returning undefined when any descendant needs a load.
  const cachedValue = (node: Node): Json | undefined => {
    if (node.tag === "v" || node.tag === "p") return payload(node)
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
  const materialize = (node: Node): Effect.Effect<Json, GroveError> => attempt(() => cachedValue(node)).pipe(
    Effect.flatMap(cached => cached === undefined ? loadValue(node) : Effect.succeed(cached)),
  )
  const loadValue = (node: Node): Effect.Effect<Json, GroveError> => Effect.gen(function* () {
    switch (node.tag) {
      case "v": case "p": return payload(node) as Json
      case "a": return yield* readNode(node.links[0]!).pipe(Effect.flatMap(materialize))
      case "r": return yield* Effect.forEach(node.links, child => readNode(child).pipe(Effect.flatMap(materialize)))
      case "c": return (yield* Effect.forEach(node.links, child => readNode(child).pipe(Effect.flatMap(materialize)))).flat() as Json
      case "o": return Object.fromEntries(yield* Effect.forEach(node.links, (child, index) => readNode(child).pipe(Effect.flatMap(materialize), Effect.map(value => [(payload(node) as readonly (readonly [string, unknown])[])[index]![0], value]))))
    }
  })
  const hydrate = (ref: string | Node): Effect.Effect<Node, GroveError> => readNode(ref).pipe(Effect.flatMap(node => Effect.forEach(node.links, hydrate).pipe(Effect.map(links => withLinks(node, links)))))
  const at = (ref: string | Node, path: Path): Effect.Effect<Selection, GroveError> => readNode(ref).pipe(Effect.flatMap(node => Effect.gen(function* () {
    if (!path.length) return { node }
    const [key, ...tail] = path
    if (node.tag === "v" || node.tag === "p") return { value: yield* attempt(() => jsonPath(payload(node), path)) }
    if (node.tag === "o") {
      const index = (payload(node) as [string, unknown][]).findIndex(([name]) => name === key)
      return index < 0 ? yield* error("Invalid object path") : yield* at(node.links[index]!, tail)
    }
    if (typeof key !== "number" || !natural(key)) return yield* error("Invalid array path")
    if (node.tag === "a") return key < node.count ? yield* at(node.links[0]!, path) : yield* error("Invalid array path")
    if (node.tag === "r") return key < node.count ? yield* at(node.links[key]!, tail) : yield* error("Invalid array path")
    let offset = key
    for (const child of node.links) {
      if (offset < child.count) return yield* at(child, [offset, ...tail])
      offset -= child.count
    }
    return yield* error("Invalid array path")
  })))
  const size = (node: Node): number | undefined => node.tag === "v" ? Array.isArray(payload(node)) ? (payload(node) as readonly Json[]).length : undefined : node.tag === "o" ? undefined : node.count
  const range = (node: Node, start: number, end: number): Effect.Effect<readonly Json[], GroveError> => Effect.gen(function* () {
    if (start === end) return []
    if (node.tag === "v" || node.tag === "p") return (payload(node) as readonly Json[]).slice(start, end)
    if (node.tag === "a") return yield* readNode(node.links[0]!).pipe(Effect.flatMap(child => range(child, start, end)))
    if (node.tag === "r") return yield* Effect.forEach(node.links.slice(start, end), child => readNode(child).pipe(Effect.flatMap(materialize)))
    const values: Json[] = []
    let offset = 0
    for (const child of node.links) {
      if (offset >= end) break
      if (offset + child.count > start) values.push(...yield* readNode(child).pipe(Effect.flatMap(node => range(node, Math.max(0, start - offset), Math.min(child.count, end - offset)))))
      offset += child.count
    }
    return values
  })
  const tail = (ref: Node): Effect.Effect<Node, GroveError> => readNode(ref).pipe(Effect.flatMap(node => Effect.gen(function* () {
    if (node.tag !== "c") return node
    const links = [...node.links]
    const previous = links.at(-2)
    if (node.level === 1 && previous && mergeablePages(previous, links.at(-1)!, options.pageItems ?? DEFAULT_PAGE_ITEMS, options.leafBytes ?? DEFAULT_LEAF_BYTES)) links[links.length - 2] = yield* readNode(previous)
    links[links.length - 1] = yield* tail(links.at(-1)!)
    return withLinks(node, links)
  })))
  const segment = (ref: Node, index: number, path: Path, append: boolean): Effect.Effect<Node, GroveError> => readNode(ref).pipe(Effect.flatMap(node => Effect.gen(function* () {
    if (node.tag === "p") return node
    const links = [...node.links]
    if (node.tag === "r") links[index] = yield* prepare(links[index]!, path, append)
    else {
      let offset = index
      const i = links.findIndex(child => { if (offset < child.count) return true; offset -= child.count; return false })
      if (i < 0) return yield* error("Invalid array path")
      links[i] = yield* segment(links[i]!, offset, path, append)
    }
    return withLinks(node, links)
  })))
  const prepare = (ref: string | Node, path: Path, append: boolean): Effect.Effect<Node, GroveError> => !append && !path.length && typeof ref !== "string" ? Effect.succeed(ref) : readNode(ref).pipe(Effect.flatMap(node => Effect.gen(function* () {
    if (node.tag === "v") return node
    if (!path.length) return append && node.tag === "a" ? withLinks(node, [yield* tail(node.links[0]!)]) : node
    const [key, ...rest] = path
    const links = [...node.links]
    if (node.tag === "a") {
      if (typeof key !== "number" || !natural(key) || key >= node.count) return yield* error("Invalid array path")
      return withLinks(node, [yield* segment(links[0]!, key, rest, append)])
    }
    if (node.tag !== "o" || typeof key !== "string") return yield* error("Invalid object path")
    const index = (payload(node) as [string, unknown][]).findIndex(([name]) => name === key)
    if (index >= 0) links[index] = yield* prepare(links[index]!, rest, append)
    return withLinks(node, links)
  })))
  // superseded evicts the loaded path an edit replaced, since each edit decodes a new version of the same content; a later read of the old root reloads it.
  const superseded = (before: Node, after: Tree): Tree => {
    const kept = new Set<string>()
    const keep = (node: Node) => { if (kept.has(node.hash)) return; kept.add(node.hash); for (const link of node.links) keep(link) }
    keep(after.node)
    const drop = (node: Node) => {
      if (node.opaque || kept.has(node.hash)) return
      const bytes = sizes.get(node.hash)
      if (bytes !== undefined) { cache.delete(node.hash); sizes.delete(node.hash); cachedBytes -= bytes }
      for (const link of node.links) drop(link)
    }
    drop(before)
    return after
  }
  const read = (root: string, path: Path = []) => at(root, path).pipe(Effect.flatMap(selected => "value" in selected ? Effect.succeed(selected.value) : materialize(selected.node)))
  const slice = (root: string, path: Path, start: number, end: number) => at(root, path).pipe(Effect.flatMap((selected): Effect.Effect<readonly Json[], GroveError> => {
    if (!natural(start) || !natural(end) || start > end) return error("Invalid Merkle range")
    if ("value" in selected) return Array.isArray(selected.value) ? Effect.succeed(selected.value.slice(start, end)) : error("Range target must be an array")
    const n = size(selected.node)
    return n === undefined ? error("Range target must be an array") : range(selected.node, Math.min(start, n), Math.min(end, n))
  }))
  return {
    bytes: (root: string) => readNode(root).pipe(Effect.map(node => node.logicalBytes)),
    tree: (root: string) => hydrate(root).pipe(Effect.map(node => plan(node, { hashedNodes: 0, hashedBytes: 0, visitedValues: 0, reusedNodes: 0 }))),
    read,
    readEach: (root: string, path: Path, each: Path) => read(root, path).pipe(Effect.flatMap(value => attempt(() => {
      if (!Array.isArray(value)) throw new Error("Selection target must be an array")
      return value.map(item => jsonPath(item, each))
    }))),
    length: (root: string, path: Path = []) => at(root, path).pipe(Effect.flatMap(selected => {
      const n = "value" in selected ? Array.isArray(selected.value) ? selected.value.length : undefined : size(selected.node)
      return n === undefined ? error("Length target must be an array") : Effect.succeed(n)
    })),
    slice,
    sliceEach: (root: string, path: Path, start: number, end: number, each: Path) => slice(root, path, start, end).pipe(Effect.flatMap(values => attempt(() => values.map(value => jsonPath(value, each))))),
    set: (root: string, path: Path, value: Json) => prepare(root, path, false).pipe(Effect.flatMap(node => attempt(() => superseded(node, tree.set(plan(node, { hashedNodes: 0, hashedBytes: 0, visitedValues: 0, reusedNodes: 0 }), path, value))))),
    append: (root: string, path: Path, values: readonly Json[]) => prepare(root, path, true).pipe(Effect.flatMap(node => attempt(() => superseded(node, tree.append(plan(node, { hashedNodes: 0, hashedBytes: 0, visitedValues: 0, reusedNodes: 0 }), path, values))))),
    batch: (root: string, edits: readonly Edit[]): Effect.Effect<Tree, GroveError> => Effect.gen(function* () {
      let node = yield* readNode(root)
      const metrics = { hashedNodes: 0, hashedBytes: 0, visitedValues: 0, reusedNodes: 0 }
      let group: Edit[] = []
      const flush = () => Effect.gen(function* () {
        if (!group.length) return
        for (const edit of group) node = yield* prepare(node, edit.path, edit.type === "append")
        const changed = yield* attempt(() => superseded(node, tree.batch(plan(node, metrics), group)))
        for (const key of Object.keys(metrics) as (keyof typeof metrics)[]) metrics[key] += changed.metrics[key]
        node = changed.node; group = []
      })
      for (const edit of edits) {
        if (group.some(previous => previous.path.slice(0, Math.min(previous.path.length, edit.path.length)).every((key, index) => key === edit.path[index]))) yield* flush()
        group.push(edit)
      }
      yield* flush()
      return plan(node, metrics)
    }),
    stats: () => ({ ...metrics, cachedNodes: cache.size, cachedBytes, cacheBudgetBytes: cacheBytes }),
    clear: () => { cache.clear(); sizes.clear(); cachedBytes = 0 },
  }
}
