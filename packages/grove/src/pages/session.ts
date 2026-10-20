import { freezeJson } from "../storage/nodes"
import { incrementalValidator, invalid } from "../session/validation"
import { Exit, Schema } from "effect"
import type { Json, Path, MerkleTree, Selection, ValueReference } from "../index"
import { encodeReference, storedValues, referenceLocator } from "../value"
import { childSchema, editableSchema, removableSchema, treeSchema } from "../schema"
import { freeze } from "../reducer/json"
import { rememberState, type PlainOptions, type PlainVersion } from "../reducer/adapter"
import { documents, type Value } from "./document"
type Node = Value
type Edit = { readonly type: "set"; readonly path: Path; readonly value: Json } | { readonly type: "remove"; readonly path: Path } | { readonly type: "splice"; readonly path: Path; readonly start: number; readonly deleteCount: number; readonly items: readonly Json[] }

// session shares authoring and selective reads across memory and SQLite placement (test/pages.test.ts).
export function session(options: {
  readonly engine: ReturnType<typeof documents>
  readonly scope: string
  readonly root: (id: string) => Value
  readonly stage: (value: Value) => string
  readonly anchor?: (id: string) => object
  readonly readLegacy: (ref: ValueReference<unknown>) => Json
}) {
  const { engine: pages, scope, root, stage, readLegacy } = options
  const documents = new WeakSet<object>(), anchors = new WeakMap<object, object>()
  const owns = (ref: ValueReference<unknown>) => JSON.parse(encodeReference(ref)).scope === scope
  const locate = (ref: ValueReference<unknown>) => referenceLocator(ref, scope)
  const viewOf = (node: Node) => pages.view(() => node)
  const scan = function* (node: Node, path: Path, range?: { readonly start: number; readonly end: number }, each?: Path): IterableIterator<Json> {
    const array = pages.select(node, path)
    if (array === null || typeof array !== "object" || array.type !== "array") throw new Error("Scan requires array")
    const { start, end } = range ?? { start: 0, end: array.root.count }
    for (const [, item] of pages.pages.scan(array.root, start, end)) yield pages.materialize(each ? pages.select(item, each) : item)
  }
  const editNode = (node: Node, edits: readonly Edit[]) => pages.edit(node, editor => {
    for (const edit of edits) {
      if (edit.type === "set") editor.set(edit.path, edit.value)
      else if (edit.type === "remove") editor.remove(edit.path)
      else editor.splice(edit.path, edit.start, edit.deleteCount, edit.items)
    }
  })
  const values = storedValues(scope, {
    read: (id, path) => viewOf(root(id)).read(path), length: (id, path) => viewOf(root(id)).length(path),
    scan: (id, path, range, each) => scan(root(id), path, range, each),
  })
  const register = <Value>(id: string, path: Path = [], each?: Path, range?: { readonly start: number; readonly end: number }) => {
    const token = Object.freeze({}) as Selection<Value>
    values.register(token, { root: id, path, ...(each === undefined ? {} : { each }), ...(range === undefined ? {} : { range }) })
    const anchor = options.anchor?.(id)
    if (anchor) { anchors.set(token, anchor); anchors.set(values.reference(token), anchor) }
    return token
  }
  const bind = <State extends Json>(schema: Schema.Decoder<State>) => {
    treeSchema(schema.ast)
    const owned = new WeakSet<object>(), schemaAt = (path: Path) => path.reduce(childSchema, schema.ast)
    const check = (path: Path, value: unknown): Json => freezeJson(Schema.decodeUnknownSync(Schema.make<Schema.Decoder<Json>>(schemaAt(path)), { onExcessProperty: "error" })(value))
    const set = (path: Path, value: unknown): Edit => { editableSchema(schema.ast, path); return { type: "set", path, value: check(path, value) } }
    const remove = (path: Path): Edit => { editableSchema(schema.ast, path, "remove"); removableSchema(schema.ast, path); return { type: "remove", path } }
    const splice = (node: Node, path: Path, start: number, count: number, items: readonly Json[] = [], operation: "splice" | "append" = "splice"): Edit => {
      const ast = editableSchema(schema.ast, path, operation)
      if (ast._tag !== "Arrays" || ast.checks?.length) throw new Error("Array edits require an unrefined array")
      const item = Schema.make<Schema.Decoder<Json>>(ast.rest[0]!)
      if (start < 0 || count < 0 || start + count > viewOf(node).length(path)) throw new RangeError("Invalid splice range")
      return { type: "splice", path, start, deleteCount: count, items: items.map(value => freeze(Schema.decodeSync(item, { onExcessProperty: "error" })(value))) }
    }
    const open = (id: string): MerkleTree<State> => {
      root(id)
      const edit = (edits: readonly Edit[]) => open(stage(editNode(root(id), edits)))
      const view = Object.freeze({
        reference: values.reference(register<State>(id)),
        read: (path: Path) => check(path, viewOf(root(id)).read(path)),
        has: (path: Path) => { schemaAt(path); return viewOf(root(id)).has(path) },
        length: (path: Path) => viewOf(root(id)).length(path),
        slice: (path: Path, start: number, end: number) => Array.from(scan(root(id), path, { start, end }), value => check([...path, start], value)),
        select: (path: Path) => { schemaAt(path); pages.select(root(id), path); return register(id, path) },
        selectEach: (path: Path, each: Path, range?: { readonly start: number; readonly end: number }) => {
          const ast = schemaAt(path)
          if (ast._tag !== "Arrays") throw new Error("Selection requires an array")
          each.reduce(childSchema, ast.rest[0]!)
          if (range && (range.start < 0 || range.end < range.start || range.end > viewOf(root(id)).length(path))) throw new RangeError("Invalid selection range")
          return register(id, path, each, range)
        },
        set: (path: Path, value: Json) => edit([set(path, value)]),
        remove: (path: Path) => edit([remove(path)]),
        append: (path: Path, items: readonly Json[]) => edit([splice(root(id), path, viewOf(root(id)).length(path), 0, items, "append")]),
        splice: (path: Path, start: number, count: number, items?: readonly Json[]) => edit([splice(root(id), path, start, count, items)]),
        batch: (callback: (mutations: { readonly set: (path: Path, value: Json) => void; readonly remove: (path: Path) => void; readonly append: (path: Path, items: readonly Json[]) => void; readonly splice: (path: Path, start: number, count: number, items?: readonly Json[]) => void }) => unknown) => {
          let next = root(id), active = true
          const apply = (edit: Edit) => { if (!active) throw new Error("Editor expired"); next = editNode(next, [edit]) }
          try { const result = callback({ set: (path, value) => apply(set(path, value)), remove: path => apply(remove(path)),
            append: (path, items) => apply(splice(next, path, viewOf(next).length(path), 0, items, "append")),
            splice: (path, start, count, items) => apply(splice(next, path, start, count, items)),
          })
          if (result !== undefined) throw new Error("Batch callback must return undefined")
          return open(stage(next))
          } finally { active = false }
        },
      }) as unknown as MerkleTree<State>
      owned.add(view); documents.add(view); return view
    }
    return {
      initial: (value: unknown) => open(stage(pages.from(check([], value)))),
      open: (ref: ValueReference<unknown>) => { if (!owns(ref)) return open(stage(pages.from(check([], readLegacy(ref))))); const location = locate(ref); if (location.path.length || location.each || location.range) throw new Error("State requires whole-document reference"); return open(location.root) },
      check: (view: MerkleTree<State>) => { if (!owned.has(view)) throw new Error("foreign working document"); return view },
    }
  }
  const materialize = <State extends Json, Event, Metadata>(options: PlainOptions<State, Event, Metadata>) => {
    const validate = Schema.decodeUnknownSync(Schema.toType(options.schema), { onExcessProperty: "error" }), owned = new WeakSet<object>(), fast = incrementalValidator(options.schema)
    const check = (value: unknown) => { if (fast.parse(value) === invalid) validate(value); return freezeJson(freeze(value)) as State }
    const wrap = (id: string, value = pages.materialize(root(id)) as State): PlainVersion<State, Event, Metadata> => {
      const version: PlainVersion<State, Event, Metadata> = Object.freeze({
        value, reference: values.reference(register<State>(id)),
        apply: (event: Event, metadata: Metadata, position: number) => {
          const next = check(options.reduce(value, event, metadata, position))
          return Object.is(next, value) ? version : wrap(stage(pages.reconcile(root(id), value, next)), next)
        },
        update: (next: unknown) => { const checked = check(next); return Object.is(checked, value) ? version : wrap(stage(pages.reconcile(root(id), value, checked)), checked) },
        selectEach: (path: Path, each: Path, range?: { readonly start: number; readonly end: number }) => register(id, path, each, range) as Selection<never>,
      })
      owned.add(version); rememberState(value, version.selectEach); return version
    }
    return {
      initial: (value: unknown) => { const checked = check(value); return wrap(stage(pages.from(checked)), checked) },
      open: (ref: ValueReference<unknown>) => {
        if (!owns(ref)) { const value = readLegacy(ref); return wrap(stage(pages.from(check(options.migrate ? options.migrate(value) : value)))) }
        const location = locate(ref)
        if (location.path.length || location.each !== undefined || location.range !== undefined) throw new Error("State requires whole-document reference")
        const value = pages.materialize(root(location.root))
        if (options.migrate && Exit.isFailure(Schema.decodeUnknownExit(Schema.toType(options.schema), { onExcessProperty: "error" })(value))) return wrap(stage(pages.from(check(options.migrate(value)))))
        check(value); return wrap(location.root)
      },
      check: (version: PlainVersion<State, Event, Metadata>) => { if (!owned.has(version)) throw new Error("Foreign materializer"); return version },
    }
  }
  return { bind, materialize, values, register, documents }
}
