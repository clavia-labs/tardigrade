import { Effect, Schema, type SchemaAST } from "effect"
import { make as makeTree } from "./tree"
import { freezeJson, type Json, type Path, type Node } from "./codec"
import { GroveError, makeReader, type ReaderOptions } from "./effect"

const ReferencePath = Schema.Array(Schema.Union([Schema.String, Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))]))
const Range = Schema.Struct({ start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), end: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })
export const Reference = Schema.Struct({ range: Schema.optionalKey(Range), root: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)), path: ReferencePath, each: Schema.optionalKey(ReferencePath) })
const SelectionType = Symbol("GroveSelection")
export interface Selection<Value> { readonly [SelectionType]: Value }
const selections = new WeakMap<object, typeof Reference.Type>()
export const selectionReference = (value: unknown) => typeof value === "object" && value !== null ? selections.get(value) : undefined
export interface Storage { readonly load: (hash: string) => string; readonly options?: ReaderOptions }
export type StagedNodes = ReadonlyMap<string, Node>

type At<T, P extends Path> = P extends readonly [infer K, ...infer R extends Path] ? T extends readonly (infer A)[] ? K extends number ? At<A, R> : never : K extends keyof T ? At<T[K], R> : never : T
type Valid<T, P extends Path> = At<T, P> extends never ? never : P
type ArrayPath<T, P extends Path> = At<T, P> extends readonly unknown[] ? Valid<T, P> : never
type Item<T> = T extends readonly (infer A)[] ? A : never
export interface MerkleTree<State> {
  readonly root: string
  readonly read: <const P extends Path>(path: Valid<State, P>) => At<State, P>
  readonly select: <const P extends Path>(path: Valid<State, P>) => Selection<At<State, P>>
  readonly selectEach: <const P extends Path, const Q extends Path>(path: ArrayPath<State, P>, each: Valid<Item<At<State, P>>, Q>, range?: typeof Range.Type) => Selection<readonly At<Item<At<State, P>>, Q>[]>
  readonly length: <const P extends Path>(path: ArrayPath<State, P>) => number
  readonly slice: <const P extends Path>(path: ArrayPath<State, P>, start: number, end: number) => readonly Item<At<State, P>>[]
  readonly set: <const P extends Path>(path: Valid<State, P>, value: At<State, P>) => MerkleTree<State>
  readonly append: <const P extends Path>(path: ArrayPath<State, P>, values: readonly Item<At<State, P>>[]) => MerkleTree<State>
}
const jsonSchema = (ast: SchemaAST.AST, seen = new Set<SchemaAST.AST>()): void => {
  if (ast === Schema.Json.ast || seen.has(ast)) return
  seen.add(ast)
  if (ast.encoding) throw new Error("Tree schemas must describe plain JSON")
  switch (ast._tag) {
    case "Objects":
      for (const p of ast.propertySignatures) { if (typeof p.name === "symbol") throw new Error("Tree fields must have JSON keys"); jsonSchema(p.type, seen) }
      for (const p of ast.indexSignatures) jsonSchema(p.type, seen)
      return
    case "Arrays": for (const a of [...ast.elements, ...ast.rest]) jsonSchema(a, seen); return
    case "Union": for (const a of ast.types) jsonSchema(a, seen); return
    case "Suspend": jsonSchema(ast.thunk(), seen); return
    case "String": case "Number": case "Boolean": case "Null": case "Literal": return
    default: throw new Error(`Unsupported tree schema: ${ast._tag}`)
  }
}
// treeSchema excludes container checks because selective edits cannot validate constraints spanning siblings (test/state.test.ts).
export const treeSchema = (ast: SchemaAST.AST): void => {
  if (ast.encoding || ast.context) throw new Error("Tree schemas must describe plain JSON")
  switch (ast._tag) {
    case "Objects":
      if (ast.checks?.length || ast.indexSignatures.length || ast.propertySignatures.some(p => p.type.context?.isOptional)) throw new Error("Tree structs require fixed fields without container checks")
      for (const p of ast.propertySignatures) treeSchema(p.type)
      return
    case "Arrays":
      if (ast.checks?.length || ast.elements.length || ast.rest.length !== 1) throw new Error("Tree arrays require homogeneous elements without container checks")
      jsonSchema(ast.rest[0]!); return
    case "Union": case "Suspend": jsonSchema(ast); return
    case "String": case "Number": case "Boolean": case "Null": case "Literal": return
    default: throw new Error(`Unsupported tree schema: ${ast._tag}`)
  }
}
const child = (ast: SchemaAST.AST, key: string | number): SchemaAST.AST => {
  if (ast.checks?.length && (ast._tag === "Objects" || ast._tag === "Arrays")) throw new Error("Refined containers require whole-value edits")
  if (ast._tag === "Objects" && typeof key === "string") {
    const p = ast.propertySignatures.find(p => p.name === key)
    if (p) return p.type
  }
  if (ast._tag === "Arrays" && typeof key === "number" && Number.isSafeInteger(key) && key >= 0) return ast.rest[0]!
  throw new Error("Invalid schema path")
}

// make stages immutable edits until committed; load must complete synchronously (test/state.test.ts).
export function make(storage: Storage) {
  const pending = new Map<string, Node>()
  const superseded = new WeakMap<StagedNodes, readonly (readonly [string, Node])[]>()
  const builder = makeTree(storage.options)
  const reader = makeReader(hash => Effect.try({ try: () => pending.get(hash)?.text ?? storage.load(hash), catch: GroveError.from }), storage.options)
  const bind = <State extends Json>(schema: Schema.Decoder<State>) => {
    const views = new WeakSet<object>()
    treeSchema(schema.ast)
    const schemaAt = (path: Path) => path.reduce(child, schema.ast)
    const check = (ast: SchemaAST.AST, value: unknown) => freezeJson(Schema.decodeUnknownSync(Schema.make<Schema.Decoder<Json>>(ast), { onExcessProperty: "error" })(value))
    const stage = (tree: ReturnType<typeof builder.from>): MerkleTree<State> => {
      for (const [hash, node] of tree.nodes) pending.set(hash, node)
      return open(tree.root)
    }
    const open = (root: string): MerkleTree<State> => {
      const view: MerkleTree<State> = Object.freeze({
        root,
        read: (path: Path) => check(schemaAt(path), Effect.runSync(reader.read(root, path))) as never,
        select: (path: Path) => {
          schemaAt(path)
          const ref = Object.freeze({}) as Selection<never>
          selections.set(ref, { root, path: Object.freeze([...path]) })
          return ref
        },
        selectEach: (path: Path, each: Path, range?: typeof Range.Type) => {
          const ast = schemaAt(path)
          if (ast._tag !== "Arrays") throw new Error("Selection target must be an array")
          each.reduce(child, ast.rest[0]!)
          const ref = Object.freeze({}) as Selection<never>
          if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end > Effect.runSync(reader.length(root, path)))) throw new RangeError("Invalid selection range")
          selections.set(ref, { root, path: Object.freeze([...path]), each: Object.freeze([...each]), ...(range ? { range: Object.freeze({ ...range }) } : {}) })
          return ref
        },
        length: (path: Path) => Effect.runSync(reader.length(root, path)),
        slice: (path: Path, start: number, end: number) => {
          const ast = schemaAt(path)
          if (ast._tag !== "Arrays") throw new Error("Slice target must be an array")
          return freezeJson(Effect.runSync(reader.slice(root, path, start, end)).map(value => check(ast.rest[0]!, value))) as never
        },
        set: (path: Path, value: Json) => stage(Effect.runSync(reader.set(root, path, check(schemaAt(path), value)))),
        append: (path: Path, values: readonly Json[]) => {
          const ast = schemaAt(path)
          if (ast._tag !== "Arrays") throw new Error("Append target must be an array")
          return stage(Effect.runSync(reader.append(root, path, values.map(value => check(ast.rest[0]!, value)))))
        },
      })
      views.add(view)
      return view
    }
    return {
      initial: (value: unknown) => stage(builder.from(check(schema.ast, value))),
      open,
      check: (view: MerkleTree<State>) => { if (!views.has(view)) throw new Error("Reducer returned a foreign tree"); return view },
    }
  }
  return {
    bind,
    // nodes returns staged nodes reachable from roots, the only ones a commit must write; staged nodes no root reaches are superseded edits, released by committed.
    nodes: (roots?: Iterable<string>): StagedNodes => {
      if (!roots) return new Map(pending)
      const found = new Map<string, Node>()
      const walk = (hash: string) => {
        const node = pending.get(hash)
        if (!node || found.has(hash)) return
        found.set(hash, node)
        for (const link of node.links) walk(link.hash)
      }
      for (const root of roots) walk(root)
      superseded.set(found, [...pending].filter(([hash]) => !found.has(hash)))
      return found
    },
    committed: (nodes: StagedNodes) => {
      for (const [hash, node] of [...nodes, ...superseded.get(nodes) ?? []]) if (pending.get(hash) === node) pending.delete(hash)
    },
    stats: reader.stats,
    bytes: (root: string) => Effect.runSync(reader.bytes(root)),
    read: (root: string, path: Path = []) => Effect.runSync(reader.read(root, path)),
    readReference: (ref: typeof Reference.Type) => Effect.runSync(ref.range ? reader.sliceEach(ref.root, ref.path, ref.range.start, ref.range.end, ref.each ?? []) : ref.each === undefined ? reader.read(ref.root, ref.path) : reader.readEach(ref.root, ref.path, ref.each)),
  }
}
export type Instance = ReturnType<typeof make>
