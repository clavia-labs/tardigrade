import { makeMaps, type MapStorage, type MapBatch } from "./collections/key-value"
import { makeLogs, DEFAULT_ROW_BATCH_ITEMS, type RowStorage, type LogBatch } from "./collections/append-only"
import { makeCache, DEFAULT_READ_CACHE_BYTES } from "./session/cache"
import { localOwners } from "./session/ownership"
import { Schema, type SchemaAST } from "effect"
import { make as makeTree, embed, type Edit } from "./collections/tree"
import { freezeJson, type Json, type Path, type Node } from "./storage/nodes"
import { makeReader, type ReaderOptions } from "./session/reader"
import { childSchema, treeSchema, removableSchema, editableSchema, isAppendOnly, isKeyValue, hasCollectionStorage, type EditPath, type AppendPath, type SplicePath, type RemovablePath, type At, type Valid, type ArrayPath, type Item } from "./schema"
import { storedValues, referenceLocator, encodeReference, type ValueRange, type ValueReference } from "./value"
export { treeSchema } from "./schema"

const SelectionType = Symbol("GroveSelection")
export interface Selection<Value> { readonly [SelectionType]: Value }
export interface Storage { readonly load: (hash: string) => string; readonly options?: ReaderOptions; readonly scope: string; readonly rows?: RowStorage; readonly maps?: MapStorage }
export type StagedNodes = ReadonlyMap<string, Node>
const PreparedType = Symbol("GrovePreparedBatch")
export interface PreparedBatch { readonly [PreparedType]: true; readonly nodes: ReadonlyMap<string, { readonly text: string }>; readonly logs: LogBatch; readonly maps: MapBatch }
interface InternalPreparedBatch extends PreparedBatch { readonly nodes: StagedNodes }

export interface Mutations<State, Result> {
  readonly set: <const P extends Path>(path: EditPath<State, P>, value: Exclude<At<State, P>, undefined>) => Result
  readonly append: <const P extends Path>(path: AppendPath<State, P>, values: readonly Item<At<State, P>>[]) => Result
  readonly splice: <const P extends Path>(path: SplicePath<State, P>, index: number, deleteCount: number, values?: readonly Item<At<State, P>>[]) => Result
  readonly remove: <const P extends Path>(path: P & RemovablePath<State, P> & EditPath<State, P>) => Result
}
export interface MerkleTree<State> extends Mutations<State, MerkleTree<State>> {
  // reference identifies this immutable version within its storage scope (platform/test/bun/journal.test.ts).
  readonly reference: ValueReference<State>
  readonly has: <const P extends Path>(path: Valid<State, P>) => boolean
  readonly read: <const P extends Path>(path: Valid<State, P>) => At<State, P>
  readonly select: <const P extends Path>(path: Valid<State, P>) => Selection<At<State, P>>
  readonly selectEach: <const P extends Path, const Q extends Path>(path: ArrayPath<State, P>, each: Valid<Item<At<State, P>>, Q>, range?: ValueRange) => Selection<readonly At<Item<At<State, P>>, Q>[]>
  readonly length: <const P extends Path>(path: ArrayPath<State, P>) => number
  readonly slice: <const P extends Path>(path: ArrayPath<State, P>, start: number, end: number) => readonly Item<At<State, P>>[]
  readonly batch: (edit: (mutations: Mutations<State, void>) => undefined) => MerkleTree<State>
}
const documentSessions = new WeakMap<object, (document: object) => ValueReference<unknown>>()
// documentReference rejects documents from other authoring sessions before persistence (test/transactions.test.ts).
export const documentReference = (instance: object, document: object) => {
  const describe = documentSessions.get(instance)
  if (!describe) throw new Error("Unknown Grove document session")
  return describe(document)
}

// make stages immutable edits until committed; load must complete synchronously (test/transactions.test.ts; test/collections/tree.test.ts).
export function make(storage: Storage) {
  const ownership = localOwners<ValueReference<unknown>>(encodeReference)
  const pending = new Map<string, Node>()
  const documents = new WeakSet<object>()
  const prepared = new WeakMap<PreparedBatch, { readonly nodes: StagedNodes; readonly logs: LogBatch; readonly maps: MapBatch }>()
  const cache = makeCache(storage.options?.cacheBytes ?? DEFAULT_READ_CACHE_BYTES)
  const logs = makeLogs(storage.rows, cache, storage.options?.rowBatchItems ?? DEFAULT_ROW_BATCH_ITEMS)
  const maps = makeMaps(storage.maps, cache, storage.options?.rowBatchItems ?? DEFAULT_ROW_BATCH_ITEMS)
  const builder = makeTree(storage.options, { logs, maps })
  const reader = makeReader(hash => pending.get(hash)?.text ?? storage.load(hash), storage.options, cache, logs, maps)
  const values = storedValues(storage.scope, {
    read: reader.read,
    length: reader.length,
    scan: reader.scan,
  })
  const author = <Value>(work: () => Value): Value => {
    try { return work() } catch (cause) { logs.discard(pending.values()); maps.discard(pending.values()); throw cause }
  }
  const bind = <State extends Json>(schema: Schema.Decoder<State>) => {
    const views = new WeakSet<object>()
    treeSchema(schema.ast)
    const schemaAt = (path: Path) => path.reduce(childSchema, schema.ast)
    const check = (ast: SchemaAST.AST, value: unknown) => freezeJson(Schema.decodeUnknownSync(Schema.make<Schema.Decoder<Json>>(ast), { onExcessProperty: "error" })(value))
    const prepareValue = (ast: SchemaAST.AST, value: Json, path: Path = []): Json => {
      if (!hasCollectionStorage(ast) || value === null || typeof value !== "object") return value
      if (isKeyValue(ast)) return embed(maps.create(value as Readonly<Record<string, Json>>))
      if (isAppendOnly(ast)) return embed(logs.create(value as readonly Json[], JSON.stringify(path)))
      if (ast._tag === "Suspend") return prepareValue(ast.thunk(), value, path)
      if (ast._tag === "Union") {
        const branch = ast.types.find(branch => Schema.is(Schema.make<Schema.Schema<Json>>(branch))(value))
        if (!branch) throw new Error("No matching append-only schema branch")
        return prepareValue(branch, value, path)
      }
      if (ast._tag === "Arrays" && Array.isArray(value)) {
        const tailStart = value.length - Math.max(0, ast.rest.length - 1)
        const items = value.map((item, index) => prepareValue(ast.elements[index] ?? (index >= tailStart ? ast.rest[index - tailStart + 1] : ast.rest[0])!, item, [...path, index]))
        return items
      }
      if (ast._tag === "Objects") return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        const child = ast.propertySignatures.find(field => field.name === key)?.type ?? ast.indexSignatures[0]?.type
        return [key, child ? prepareValue(child, item, [...path, key]) : item]
      }))
      return value
    }
    const entryEdit = (path: Path, value?: Json): Extract<Edit, { type: "entry" }> | undefined => {
      if (!path.length || !isKeyValue(schemaAt(path.slice(0, -1)))) return undefined
      const key = path.at(-1)
      if (typeof key !== "string") throw new Error("Key-value keys must be strings")
      return { type: "entry", path: path.slice(0, -1), key, ...(value === undefined ? {} : { value }) }
    }
    const setEdit = (path: Path, value: unknown): Extract<Edit, { type: "set" | "entry" }> => {
      const ast = editableSchema(schema.ast, path), checked = check(ast, value)
      return entryEdit(path, checked) ?? { type: "set", path: [...path], value: prepareValue(ast, checked, path) }
    }
    const removeEdit = (path: Path): Edit => {
      editableSchema(schema.ast, path, "remove"); removableSchema(schema.ast, path)
      return entryEdit(path) ?? { type: "remove", path: [...path] }
    }
    const appendValues = (path: Path, values: readonly Json[], splice = false) => {
      const ast = editableSchema(schema.ast, path, splice ? "splice" : "append")
      if (ast._tag !== "Arrays") throw new Error("Edit target must be an array")
      if (ast.checks?.length) throw new Error("Refined containers require whole-value edits")
      if (!Array.isArray(values)) throw new Error("Array edit values must be an array")
      return Array.from(values, value => isAppendOnly(ast) ? check(ast.rest[0]!, value) : prepareValue(ast.rest[0]!, check(ast.rest[0]!, value), path))
    }
    const stage = (tree: ReturnType<typeof builder.from>): MerkleTree<State> => {
      for (const [hash, node] of tree.nodes) pending.set(hash, node)
      return open(tree.root)
    }
    const open = (root: string): MerkleTree<State> => {
      const token = Object.freeze({}) as Selection<State>
      values.register(token, { root, path: [] })
      const reference = values.reference(token)
      const view: MerkleTree<State> = Object.freeze({
        reference,
        has: (path: Path) => { schemaAt(path); return reader.has(root, path) },
        read: (path: Path) => check(schemaAt(path), reader.read(root, path)) as never,
        select: (path: Path) => {
          schemaAt(path)
          const ref = Object.freeze({}) as Selection<never>
          values.register(ref, { root, path })
          return ref
        },
        selectEach: (path: Path, each: Path, range?: ValueRange) => {
          const ast = schemaAt(path)
          if (ast._tag !== "Arrays") throw new Error("Selection target must be an array")
          each.reduce(childSchema, ast.rest[0]!)
          const ref = Object.freeze({}) as Selection<never>
          if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end > reader.length(root, path))) throw new RangeError("Invalid selection range")
          values.register(ref, { root, path, each, ...(range ? { range } : {}) })
          return ref
        },
        length: (path: Path) => reader.length(root, path),
        slice: (path: Path, start: number, end: number) => {
          const ast = schemaAt(path)
          if (ast._tag !== "Arrays") throw new Error("Slice target must be an array")
          return freezeJson(reader.slice(root, path, start, end).map(value => check(ast.rest[0]!, value))) as never
        },
        set: (path: Path, value: Json) => author(() => { const edit = setEdit(path, value); return stage(edit.type === "entry" ? reader.entry(root, edit.path, edit.key, edit.value) : reader.set(root, path, edit.value)) }),
        append: (path: Path, values: readonly Json[]) => author(() => stage(reader.append(root, path, appendValues(path, values)))),
        splice: (path: Path, index: number, deleteCount: number, values: readonly Json[] = []) => author(() => stage(reader.splice(root, path, index, deleteCount, appendValues(path, values, true)))),
        remove: (path: Path) => { const edit = removeEdit(path); return stage(edit.type === "entry" ? reader.entry(root, edit.path, edit.key, undefined) : reader.remove(root, path)) },
        batch: (edit: (mutations: Mutations<State, void>) => undefined) => author(() => {
          const edits: Edit[] = []
          const result = edit({
            set: (path: Path, value: Json) => { edits.push(setEdit(path, value)) },
            append: (path: Path, values: readonly Json[]) => { edits.push({ type: "append", path: [...path], values: appendValues(path, values) }) },
            splice: (path: Path, index: number, deleteCount: number, values: readonly Json[] = []) => { edits.push({ type: "splice", path: [...path], index, deleteCount, values: appendValues(path, values, true) }) },
            remove: (path: Path) => { edits.push(removeEdit(path)) },
          })
          if (result !== undefined) throw new Error("Batch callback must be synchronous and return undefined")
          return edits.length ? stage(reader.batch(root, edits)) : view
        }),
      })
      views.add(view)
      documents.add(view)
      return view
    }
    return {
      initial: (value: unknown) => author(() => stage(builder.from(prepareValue(schema.ast, check(schema.ast, value))))),
      open: (reference: ValueReference<unknown>) => {
        const selected = referenceLocator(reference, storage.scope)
        if (selected.path.length || selected.each !== undefined || selected.range !== undefined) throw new Error("Opening a document requires a whole-document reference")
        return open(selected.root)
      },
      check: (view: MerkleTree<State>) => { if (!views.has(view)) throw new Error("Reducer returned a foreign tree"); return view },
    }
  }
  const staging = {
    // prepare snapshots reachable staged entries, or all staging when references are omitted (test/transactions.test.ts; test/collections/tree.test.ts).
    prepare: (references?: Iterable<ValueReference<unknown>>): InternalPreparedBatch => {
      const found = new Map<string, Node>()
      const walk = (hash: string) => {
        const node = pending.get(hash)
        if (!node || found.has(hash)) return
        found.set(hash, node)
        for (const link of node.links) walk(link.hash)
      }
      if (references === undefined) for (const [hash, node] of pending) found.set(hash, node)
      else for (const reference of references) walk(referenceLocator(reference, storage.scope).root)
      const batch = Object.freeze({ [PreparedType]: true as const, nodes: found, logs: logs.snapshot(found.values()), maps: maps.snapshot(found.values()) })
      prepared.set(batch, { nodes: found, logs: batch.logs, maps: batch.maps })
      return batch
    },
    // acknowledge releases exact entries captured by this session after persistence succeeds (test/transactions.test.ts; test/collections/tree.test.ts).
    acknowledge: (batch: PreparedBatch) => {
      const captured = prepared.get(batch)
      if (!captured) throw new Error("Grove staging batch is foreign or already acknowledged")
      logs.acknowledge(captured.logs)
      maps.acknowledge(captured.maps)
      for (const [hash, node] of captured.nodes) if (pending.get(hash) === node) pending.delete(hash)
      prepared.delete(batch)
    },
    // discard abandons unheld staging while preserving draft dependencies and cached committed values (test/transactions.test.ts; platform/test/bun/journal.test.ts).
    discard: (references: Iterable<ValueReference<unknown>> = ownership.held()) => {
      const retained = staging.prepare(references).nodes
      logs.discard(retained.values())
      maps.discard(retained.values())
      const discarded = [...pending.keys()].filter(hash => !retained.has(hash))
      reader.evict(discarded)
      for (const hash of discarded) pending.delete(hash)
    },
  }
  const instance = {
    hold: (holder: object, name: string, reference: ValueReference<unknown>) => {
      referenceLocator(reference, storage.scope)
      ownership.hold(holder, name, reference)
    },
    release: ownership.release, held: ownership.held,
    bind,
    // capture stages immutable JSON without an editable document schema (test/references.test.ts).
    capture: (value: Json): ValueReference<Json> => {
      const tree = builder.from(freezeJson(Schema.decodeSync(Schema.Json)(value)))
      for (const [hash, node] of tree.nodes) pending.set(hash, node)
      const token = Object.freeze({}) as Selection<Json>
      values.register(token, { root: tree.root, path: [] })
      return values.reference(token)
    },
    reference: values.reference,
    view: values.view,
    clear: reader.clear,
    staging,
    discard: () => staging.discard(),
    stats: () => ({ ...reader.stats(), ...logs.stats(), ...maps.stats(), stagedNodes: pending.size }),
    bytes: (reference: ValueReference<unknown>) => {
      const selected = referenceLocator(reference, storage.scope)
      if (selected.path.length || selected.each !== undefined || selected.range !== undefined) throw new Error("Byte measurement requires a whole-document reference")
      return reader.bytes(selected.root)
    },
    read: (reference: ValueReference<unknown>) => values.view(reference, Schema.Json).materialize(),
  }
  documentSessions.set(instance, document => {
    if (!documents.has(document)) throw new Error("Document belongs to another Grove instance")
    const reference = (document as MerkleTree<Json>).reference
    return reference
  })
  return instance
}
export type Instance = Pick<ReturnType<typeof make>, "bind" | "capture" | "reference" | "view" | "read" | "bytes" | "hold" | "release" | "held" | "clear" | "discard" | "stats"> & {
  readonly staging: {
    readonly prepare: (references?: Iterable<ValueReference<unknown>>) => PreparedBatch
    readonly acknowledge: (batch: PreparedBatch) => void
    readonly discard: () => void
  }
}
