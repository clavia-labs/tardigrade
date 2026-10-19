import { Schema } from "effect"
import { freezeJson, type Json, type Path } from "./storage/nodes"
import { childSchema, treeSchema, type At, type ArrayPath, type Item, type Valid } from "./schema"
import type { Selection } from "./document"

const REFERENCE_FORMAT_VERSION = 1
const ReferenceType = Symbol("GroveReference")
export interface ValueReference<Value = Json> { readonly [ReferenceType]: Value }
export interface View<Value> {
  readonly read: <const P extends Path>(path: Valid<Value, P>) => At<Value, P>
  readonly length: <const P extends Path>(path: ArrayPath<Value, P>) => number
  readonly scan: <const P extends Path>(path: ArrayPath<Value, P>, range?: ValueRange) => IterableIterator<Item<At<Value, P>>>
  readonly materialize: () => Value
}
export interface ValueRange { readonly start: number; readonly end: number }
interface Locator { readonly backend?: "reducer"; readonly root: string; readonly path: Path; readonly each?: Path; readonly range?: ValueRange }
interface Descriptor { readonly version: 1 | 2; readonly scope: string; readonly selection: Locator }
interface ValueReader {
  readonly read: (root: string, path: Path) => Json
  readonly length: (root: string, path: Path) => number
  readonly scan: (root: string, path: Path, range?: ValueRange, each?: Path) => IterableIterator<Json>
}
// ReferenceToken rejects implicit JSON serialization so callers persist the versioned codec (test/references.test.ts).
class ReferenceToken {
  toJSON(): never { throw new Error("Use encodeReference to serialize a Grove reference") }
}
const references = new WeakMap<object, Descriptor>()
const selections = new WeakMap<object, { readonly session: object; readonly reference: ValueReference<unknown> }>()
export const selectionValueReference = (value: unknown): ValueReference<unknown> | undefined => record(value) ? selections.get(value)?.reference : undefined
const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key))
const pathValid = (value: unknown): value is Path => Array.isArray(value) && value.every(key => typeof key === "string" || natural(key))
const rangeValid = (value: unknown): value is ValueRange => record(value) && keys(value, ["start", "end"]) && natural(value.start) && natural(value.end) && value.start <= value.end
const scopeValid = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
const copy = (selection: Locator): Locator => Object.freeze({
  ...(selection.backend === undefined ? {} : { backend: selection.backend }),
  root: selection.root, path: Object.freeze([...selection.path]),
  ...(selection.each === undefined ? {} : { each: Object.freeze([...selection.each]) }),
  ...(selection.range === undefined ? {} : { range: Object.freeze({ ...selection.range }) }),
})
const reference = <Value>(descriptor: Descriptor): ValueReference<Value> => {
  const token = Object.freeze(new ReferenceToken()) as unknown as ValueReference<Value>
  references.set(token, Object.freeze({ ...descriptor, selection: copy(descriptor.selection) }))
  return token
}
const descriptor = (value: unknown): Descriptor => {
  const found = record(value) ? references.get(value) : undefined
  if (!found) throw new Error("Invalid Grove reference; decode persisted references with decodeReference")
  return found
}

// encodeReference serializes identity without loading payloads (test/references.test.ts).
export const encodeReference = (value: ValueReference<unknown>): string => JSON.stringify(descriptor(value))

// decodeReference validates a scoped identity without proving its payload or schema (test/references.test.ts).
export function decodeReference(encoded: string): ValueReference {
  const value: unknown = JSON.parse(encoded)
  if (!record(value) || !keys(value, ["version", "scope", "selection"]) || (value.version !== REFERENCE_FORMAT_VERSION && value.version !== 2) || !scopeValid(value.scope)) throw new Error("Invalid Grove reference format or scope")
  const selection = value.selection
  if (!record(selection) || !keys(selection, ["root", "path", "each", "range", "backend"]) || (selection.backend !== undefined && selection.backend !== "reducer") || typeof selection.root !== "string" || !/^[a-f0-9]{64}$/.test(selection.root) || !pathValid(selection.path) || (selection.each !== undefined && !pathValid(selection.each)) || (selection.range !== undefined && !rangeValid(selection.range))) throw new Error("Invalid Grove reference selection")
  if ((value.version === 2) !== (selection.backend === "reducer")) throw new Error("Invalid Grove reference backend")
  return reference({ version: value.version, scope: value.scope, selection: selection as unknown as Locator })
}

// EncodedReference validates serialized references through Grove's versioned codec (test/references.test.ts).
export const EncodedReference = Schema.String.check(Schema.makeFilter(value => {
  try { decodeReference(value); return true } catch { return false }
}, { title: "Encoded Grove reference" }))

// referenceLocator checks storage scope before an adapter uses a reference's internal location (test/references.test.ts).
export const referenceLocator = (value: ValueReference<unknown>, scope: string): Locator => {
  const stored = descriptor(value)
  if (stored.scope !== scope) throw new Error("Grove reference storage scope mismatch")
  return stored.selection
}
export const isValueReference = (value: object): value is ValueReference<unknown> => references.has(value)

// storedValues binds references and selective views to a synchronous reader and explicit storage scope (test/references.test.ts).
export function storedValues(scope: string, reader: ValueReader) {
  if (!scopeValid(scope)) throw new Error("Grove storage scope must be nonempty")
  const session = {}
  return {
    register: (token: object, locator: Locator) => {
      selections.set(token, { session, reference: reference({ version: locator.backend === "reducer" ? 2 : REFERENCE_FORMAT_VERSION, scope, selection: locator }) })
    },
    reference: <Value>(token: Selection<Value>): ValueReference<Value> => {
      const selected = selections.get(token)
      if (!selected || selected.session !== session) throw new Error("Selection belongs to another Grove instance")
      return selected.reference as ValueReference<Value>
    },
    view: <Value extends Json>(ref: ValueReference<unknown>, schema: Schema.Decoder<Value>): View<Value> => {
      const stored = descriptor(ref)
      if (stored.scope !== scope) throw new Error("Grove reference storage scope mismatch")
      if (schema.ast !== Schema.Json.ast) treeSchema(schema.ast)
      const { root, path, each, range } = stored.selection
      const array = each !== undefined || range !== undefined
      const ast = array && schema.ast === Schema.Json.ast ? Schema.Array(Schema.Json).ast : schema.ast
      const schemaAt = (selected: Path) => selected.reduce(childSchema, ast)
      const check = (selected: Path, value: Json): Json => freezeJson(Schema.decodeSync(Schema.make<Schema.Decoder<Json>>(schemaAt(selected)), { onExcessProperty: "error" })(value))
      const bounds = () => {
        const length = reader.length(root, path)
        if (range && range.end > length) throw new RangeError("Stored selection range exceeds its source")
        return range ?? { start: 0, end: length }
      }
      const locate = (selected: Path): Path => {
        schemaAt(selected)
        if (!array) return [...path, ...selected]
        const index = selected[0]
        const { start, end } = bounds()
        if (!natural(index) || index >= end - start) throw new RangeError("Invalid view array index")
        return [...path, start + index, ...each ?? [], ...selected.slice(1)]
      }
      const length = (selected: Path): number => {
        if (schemaAt(selected)._tag !== "Arrays") throw new Error("Length target must be an array")
        if (array && !selected.length) { const { start, end } = bounds(); return end - start }
        return reader.length(root, locate(selected))
      }
      const scan = function* (selected: Path, requested?: ValueRange): IterableIterator<Json> {
        const ast = schemaAt(selected)
        if (ast._tag !== "Arrays") throw new Error("Scan target must be an array")
        const count = length(selected)
        const selectedRange = requested ?? { start: 0, end: count }
        if (!rangeValid(selectedRange) || selectedRange.end > count) throw new RangeError("Invalid view scan range")
        const offset = array && !selected.length ? bounds().start : 0
        const source = array && !selected.length ? path : locate(selected)
        const projection = array && !selected.length ? each : undefined
        const decode = Schema.decodeSync(Schema.make<Schema.Decoder<Json>>(ast.rest[0]!), { onExcessProperty: "error" })
        for (const value of reader.scan(root, source, { start: offset + selectedRange.start, end: offset + selectedRange.end }, projection)) yield freezeJson(decode(value))
      }
      return Object.freeze({
        read: ((selected: Path) => array && !selected.length ? Object.freeze(Array.from(scan([]))) : check(selected, reader.read(root, locate(selected)))) as unknown as View<Value>["read"],
        length,
        scan: ((selected: Path, requested?: ValueRange) => scan([...selected], requested === undefined ? undefined : { ...requested })) as View<Value>["scan"],
        materialize: () => (array ? Object.freeze(Array.from(scan([]))) : check([], reader.read(root, path))) as Value,
      })
    },
  }
}
