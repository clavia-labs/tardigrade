import { Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { GroveError, makeReader, type ReaderOptions } from "./effect"
import { encodeNode, type Json, type Node, type Path, type Tree } from "./codec"

export interface NodeChunk { readonly inline: Uint8Array | null; readonly ordinal: number | null; readonly payload: Uint8Array | null; readonly byte_length: number; readonly chunk_count: number }

// decodeNodeChunks verifies a complete UTF-8 node, stored inline or in ordered chunks, before the reader authenticates its hash (test/sqlite.test.ts).
export const decodeNodeChunks = (rows: readonly NodeChunk[]): string => {
  const first = rows[0]
  if (first?.inline) {
    if (rows.length !== 1 || first.chunk_count !== 1 || first.inline.byteLength !== first.byte_length) throw new GroveError({ message: "Node length mismatch" })
    return new TextDecoder("utf-8", { fatal: true }).decode(first.inline)
  }
  if (!first || rows.length !== first.chunk_count || !Number.isSafeInteger(first.byte_length) || first.byte_length < 1 || rows.some(row => !row.payload)) throw new GroveError({ message: "Node chunks missing or invalid" })
  const payload = new Uint8Array(first.byte_length)
  let offset = 0
  for (const [index, row] of rows.entries()) {
    if (row.ordinal !== index || offset + row.payload!.byteLength > payload.byteLength) throw new GroveError({ message: "Node chunks invalid" })
    payload.set(row.payload!, offset); offset += row.payload!.byteLength
  }
  if (offset !== payload.byteLength) throw new GroveError({ message: "Node length mismatch" })
  return new TextDecoder("utf-8", { fatal: true }).decode(payload)
}

// NODE_QUERY returns the inline payload, or the chunk rows of a node larger than one chunk.
const NODE_QUERY = "SELECT n.payload AS inline, c.ordinal, c.payload, n.byte_length, n.chunk_count FROM grove_nodes n LEFT JOIN grove_chunks c ON n.payload IS NULL AND c.hash = n.hash WHERE n.hash = ? ORDER BY c.ordinal"
const DIGEST_BYTES = 32
const packDigests = (hashes: readonly string[]) => {
  const packed = new Uint8Array(hashes.length * DIGEST_BYTES)
  hashes.forEach((hash, index) => { for (let i = 0; i < DIGEST_BYTES; i++) packed[index * DIGEST_BYTES + i] = parseInt(hash.slice(i * 2, i * 2 + 2), 16) })
  return packed
}
const unpackDigests = (packed: Uint8Array) => Array.from({ length: packed.byteLength / DIGEST_BYTES }, (_, index) => Array.from(packed.subarray(index * DIGEST_BYTES, (index + 1) * DIGEST_BYTES), byte => byte.toString(16).padStart(2, "0")).join(""))

// nativeLoader borrows a native single SQLite connection after releasing its reservation; execute must finish synchronously (test/workerd/lifecycle.workers.ts).
export const nativeLoader = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const context = yield* Effect.context<never>()
  const connection = yield* Effect.scoped(sql.reserve)
  return (hash: string) => Effect.runSyncWith(context)(connection.execute(NODE_QUERY, [hash], undefined).pipe(Effect.map(rows => decodeNodeChunks(rows as readonly NodeChunk[]))))
})

export const DEFAULT_CHUNK_BYTES = 128 * 1024
// DEFAULT_MAX_PARAMETERS matches the bound-parameter limit of Durable Object SQLite; node writes batch rows up to it.
export const DEFAULT_MAX_PARAMETERS = 100
export interface Options extends ReaderOptions { readonly chunkBytes?: number; readonly maxParameters?: number; readonly transaction?: SqlClient.SqlClient["withTransaction"] }

const batches = <A>(items: readonly A[], size: number, weight: (item: A) => number = () => 0, limit = Infinity): readonly (readonly A[])[] => {
  const result: A[][] = []
  let batch: A[] = []
  let total = 0
  for (const item of items) {
    const w = weight(item)
    if (batch.length && (batch.length >= size || total + w > limit)) { result.push(batch); batch = []; total = 0 }
    batch.push(item); total += w
  }
  if (batch.length) result.push(batch)
  return result
}

export const make = (options: Options = {}) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) return yield* new GroveError({ message: "chunkBytes must be a positive integer" })
  const maxParameters = options.maxParameters ?? DEFAULT_MAX_PARAMETERS
  if (!Number.isSafeInteger(maxParameters) || maxParameters < 5) return yield* new GroveError({ message: "maxParameters must be an integer of at least five" })
  // grove_nodes keeps one small row per node with its children as packed 32-byte digests for collection; grove_chunks holds the text, so lookups by hash stay on a dense index.
  yield* sql`CREATE TABLE IF NOT EXISTS grove_nodes (hash TEXT PRIMARY KEY, byte_length INTEGER NOT NULL, chunk_count INTEGER NOT NULL, children BLOB NOT NULL, payload BLOB) WITHOUT ROWID`
  yield* sql`CREATE TABLE IF NOT EXISTS grove_chunks (hash TEXT NOT NULL, ordinal INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY (hash, ordinal)) WITHOUT ROWID`
  if (!(yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('grove_nodes')`).some(column => column.name === "children")) return yield* new GroveError({ message: "Grove storage predates per-node child lists; recreate the store" })
  yield* sql`CREATE TABLE IF NOT EXISTS grove_owners (name TEXT PRIMARY KEY, root TEXT NOT NULL) WITHOUT ROWID`
  // transaction reuses the caller's transaction because Durable Object SQLite rejects savepoints (test/workerd/lifecycle.workers.ts).
  const transaction = <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.serviceOption(sql.transactionService).pipe(
    Effect.flatMap(active => Option.isSome(active) ? work : (options.transaction ?? sql.withTransaction)(work)),
  )
  const root = (owner: string) => sql<{ root: string }>`SELECT root FROM grove_owners WHERE name = ${owner}`.pipe(Effect.map(rows => rows[0]?.root), Effect.mapError(GroveError.from))
  const owned = (owner: string) => root(owner).pipe(Effect.flatMap(hash => hash === undefined ? new GroveError({ message: `Root is not owned: ${owner}` }) : Effect.succeed(hash)))
  const check = (owner: string, expected: string | null) => root(owner).pipe(Effect.flatMap(actual => (actual ?? null) === expected ? Effect.void : new GroveError({ message: `Owner root changed: ${owner}` })))
  const loadNode = (hash: string) => Effect.gen(function* () {
    const rows = yield* sql.unsafe<NodeChunk>(NODE_QUERY, [hash])
    return yield* Effect.try({ try: () => decodeNodeChunks(rows), catch: GroveError.from })
  }).pipe(Effect.mapError(GroveError.from))
  const reader = makeReader(loadNode, options)
  const existing = (hashes: readonly string[]) => Effect.gen(function* () {
    const found = new Set<string>()
    for (const batch of batches(hashes, maxParameters)) for (const row of yield* sql.unsafe<{ hash: string }>(`SELECT hash FROM grove_nodes WHERE hash IN (${batch.map(() => "?").join(", ")})`, batch)) found.add(row.hash)
    return found
  })
  const insert = (table: string, columns: readonly string[], rows: readonly (readonly unknown[])[], weight?: (row: readonly unknown[]) => number) => Effect.forEach(
    batches(rows, Math.floor(maxParameters / columns.length), weight, chunkBytes),
    batch => sql.unsafe(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${batch.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ")}`, batch.flat()),
    { discard: true },
  )
  // writeNodes stores every node reachable from roots that the database lacks, checking existence one tree level per query.
  const writeNodes = (roots: readonly Node[], available: ReadonlyMap<string, Node>) => Effect.gen(function* () {
    const seen = new Set<string>()
    const written: Node[] = []
    let frontier = roots
    while (frontier.length) {
      const level = new Map<string, Node>()
      for (const ref of frontier) if (!seen.has(ref.hash)) { seen.add(ref.hash); level.set(ref.hash, available.get(ref.hash) ?? ref) }
      const found = yield* existing([...level.keys()])
      const next: Node[] = []
      for (const node of level.values()) {
        if (found.has(node.hash)) continue
        if (node.opaque) return yield* new GroveError({ message: "Update references a missing node" })
        written.push(node); next.push(...node.links)
      }
      frontier = next
    }
    const encoded = written.map(node => {
      const payload = new TextEncoder().encode(encodeNode(node))
      const children = packDigests([...new Set(node.children)])
      return { node, payload, children }
    })
    yield* insert("grove_nodes", ["hash", "byte_length", "chunk_count", "children", "payload"], encoded.map(({ node, payload, children }) => [node.hash, payload.byteLength, Math.ceil(payload.byteLength / chunkBytes), children, null]), row => (row[3] as Uint8Array).byteLength)
    yield* insert("grove_chunks", ["hash", "ordinal", "payload"], encoded.flatMap(({ node, payload }) => Array.from({ length: Math.ceil(payload.byteLength / chunkBytes) }, (_, ordinal) => [node.hash, ordinal, payload.subarray(ordinal * chunkBytes, (ordinal + 1) * chunkBytes)])), row => (row[2] as Uint8Array).byteLength)
    return { nodes: written.length, bytes: encoded.reduce((n, { payload }) => n + payload.byteLength, 0) }
  }).pipe(Effect.mapError(GroveError.from))
  const write = (tree: Tree) => writeNodes([tree.node], new Map()).pipe(Effect.map(result => ({ ...result, root: tree.root })))
  const bind = (owner: string, hash: string) => sql`INSERT INTO grove_owners (name, root) VALUES (${owner}, ${hash}) ON CONFLICT(name) DO UPDATE SET root = excluded.root`
  const publish = (owner: string, tree: Tree, expected: string | null) => transaction(Effect.gen(function* () {
    yield* check(owner, expected)
    const written = yield* write(tree)
    yield* bind(owner, tree.root)
    return written
  })).pipe(Effect.mapError(GroveError.from))
  // replaceOwners atomically reconciles a namespace with its requested roots; names are suffixes relative to prefix (test/sqlite.test.ts).
  const replaceOwners = (prefix: string, entries: readonly { readonly name: string; readonly root: string }[]) => transaction(Effect.gen(function* () {
    const desired = new Map(entries.map(entry => [`${prefix}${entry.name}`, entry.root]))
    if (desired.size !== entries.length) return yield* new GroveError({ message: "Duplicate owner name" })
    const previous = yield* sql<{ name: string; root: string }>`SELECT name, root FROM grove_owners WHERE substr(name, 1, ${prefix.length}) = ${prefix}`
    const current = new Map(previous.map(entry => [entry.name, entry.root]))
    for (const entry of previous) if (!desired.has(entry.name)) yield* sql`DELETE FROM grove_owners WHERE name = ${entry.name}`
    for (const [name, hash] of desired) {
      if (current.get(name) === hash) continue
      if (!(yield* sql`SELECT hash FROM grove_nodes WHERE hash = ${hash}`).length) return yield* new GroveError({ message: `Cannot retain missing root ${hash} for ${name}` })
      yield* bind(name, hash)
    }
  })).pipe(Effect.mapError(GroveError.from))
  const edit = (owner: string, expected: string, update: (hash: string) => Effect.Effect<Tree, GroveError>) => transaction(Effect.gen(function* () {
    yield* check(owner, expected)
    const before = reader.stats()
    const tree = yield* update(expected)
    const written = yield* write(tree)
    yield* bind(owner, tree.root)
    const after = reader.stats()
    return { ...written, loadedNodes: after.loadedNodes - before.loadedNodes, loadedBytes: after.loadedBytes - before.loadedBytes }
  })).pipe(Effect.mapError(GroveError.from))
  return {
    transaction, root, publish, replaceOwners,
    stage: (nodes: ReadonlyMap<string, Node>) => transaction(writeNodes([...nodes.values()], nodes)),
    tree: (owner: string) => transaction(owned(owner).pipe(Effect.flatMap(hash => reader.tree(hash)))).pipe(Effect.mapError(GroveError.from)),
    read: (owner: string, path: Path = []) => transaction(owned(owner).pipe(Effect.flatMap(hash => reader.read(hash, path)))).pipe(Effect.mapError(GroveError.from)),
    slice: (owner: string, path: Path, start: number, end: number) => transaction(owned(owner).pipe(Effect.flatMap(hash => reader.slice(hash, path, start, end)))).pipe(Effect.mapError(GroveError.from)),
    set: (owner: string, expected: string, path: Path, value: Json) => edit(owner, expected, hash => reader.set(hash, path, value)),
    append: (owner: string, expected: string, path: Path, values: readonly Json[]) => edit(owner, expected, hash => reader.append(hash, path, values)),
    retain: (owner: string, hash: string, expected: string | null) => transaction(Effect.gen(function* () {
      yield* check(owner, expected)
      if (!(yield* sql`SELECT hash FROM grove_nodes WHERE hash = ${hash}`).length) return yield* new GroveError({ message: `Cannot retain missing root ${hash} for ${owner}` })
      yield* bind(owner, hash)
    })).pipe(Effect.mapError(GroveError.from)),
    release: (owner: string, expected: string) => transaction(Effect.gen(function* () {
      if ((yield* root(owner)) === undefined) return
      yield* check(owner, expected)
      yield* sql`DELETE FROM grove_owners WHERE name = ${owner}`
    })).pipe(Effect.mapError(GroveError.from)),
    collect: transaction(Effect.gen(function* () {
      const before = (yield* sql<{ nodes: number; bytes: number }>`SELECT COUNT(*) nodes, COALESCE(SUM(byte_length), 0) bytes FROM grove_nodes`)[0]!
      // Collection reads child lists breadth first from owned roots, then deletes unreached nodes in batches, so edits write no per-child index rows.
      const live = new Set<string>()
      let frontier = [...new Set((yield* sql<{ root: string }>`SELECT root FROM grove_owners`).map(row => row.root))]
      while (frontier.length) {
        for (const hash of frontier) live.add(hash)
        const next = new Set<string>()
        for (const batch of batches(frontier, maxParameters)) for (const row of yield* sql.unsafe<{ children: Uint8Array }>(`SELECT children FROM grove_nodes WHERE hash IN (${batch.map(() => "?").join(", ")})`, batch)) for (const child of unpackDigests(row.children)) if (!live.has(child)) next.add(child)
        frontier = [...next]
      }
      const dead = (yield* sql<{ hash: string }>`SELECT hash FROM grove_nodes`).map(row => row.hash).filter(hash => !live.has(hash))
      for (const batch of batches(dead, maxParameters)) {
        const marks = batch.map(() => "?").join(", ")
        yield* sql.unsafe(`DELETE FROM grove_nodes WHERE hash IN (${marks})`, batch)
        yield* sql.unsafe(`DELETE FROM grove_chunks WHERE hash IN (${marks})`, batch)
      }
      const after = (yield* sql<{ nodes: number; bytes: number }>`SELECT COUNT(*) nodes, COALESCE(SUM(byte_length), 0) bytes FROM grove_nodes`)[0]!
      return { nodes: before.nodes - after.nodes, bytes: before.bytes - after.bytes }
    })).pipe(Effect.mapError(GroveError.from)),
    stats: reader.stats,
    clear: reader.clear,
  }
}).pipe(Effect.mapError(GroveError.from))

export class Grove extends Context.Service<Grove, Effect.Success<ReturnType<typeof make>>>()("@tardie/grove") {}
export const layer = (options: Options = {}) => Layer.effect(Grove, make(options))
