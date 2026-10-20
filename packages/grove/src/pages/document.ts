import { freezeJson } from "../storage/nodes"
import { tree, type Key, type Node, type Page } from "./tree"

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }
export type Path = readonly (string | number)[]
type Scalar = null | boolean | number | string
export type Value = Scalar | Container | Text | Field
export interface Field { readonly type: "field"; readonly order: number; readonly value: Value }
export interface Container { readonly type: "object" | "array"; readonly root: Node<Key, Value>; readonly next?: number }
export type Text = { readonly type: "text"; readonly value: string } | { readonly type: "text"; readonly id: number }
export interface View<State extends Json = Json> {
  readonly read: { (path: readonly []): State; (path: Path): Json }
  readonly has: (path: Path) => boolean
  readonly length: (path: Path) => number
  readonly slice: (path: Path, start: number, end: number) => readonly Json[]
}
export interface Editor extends View {
  readonly set: (path: Path, value: Json) => void
  readonly remove: (path: Path) => void
  readonly append: (path: Path, items: readonly Json[]) => void
  readonly splice: (path: Path, start: number, deleteCount: number, items: readonly Json[]) => void
}
export const DEFAULT_INLINE_BYTES = 64

// documents maps JSON containers onto shared keyed/ranked pages (test/page-document.test.ts).
export function documents(options: {
  readonly capacity?: number
  readonly inlineBytes?: number
  readonly loadPage?: (id: number) => Page<Key, Value>
  readonly loadText?: (id: number) => string
  readonly allocated?: (page: Page<Key, Value>) => void
  readonly allocatedText?: (text: Text) => void
  readonly materialized?: () => void
  readonly equivalent?: (value: Value, previous: Value) => boolean
} = {}) {
  const inlineBytes = options.inlineBytes ?? DEFAULT_INLINE_BYTES
  if (!Number.isSafeInteger(inlineBytes) || inlineBytes < 0) throw new RangeError("Inline bytes must be a nonnegative safe integer")
  const pages = tree<Key, Value>({ ...(options.capacity === undefined ? {} : { capacity: options.capacity }), ...(options.loadPage ? { load: options.loadPage } : {}), ...(options.allocated ? { allocated: options.allocated } : {}) })
  let known = new WeakMap<object, Value>()
  const container = (type: Container["type"], root: Node<Key, Value>, next?: number): Container => Object.freeze({ type, root, ...(next === undefined ? {} : { next }) })
  const field = (value: Value, order: number): Field => Object.freeze({ type: "field", order, value })
  const compare = (a: Key, b: Key) => {
    if (typeof a !== "string" || typeof b !== "string") throw new Error("Object keys must be strings")
    return a < b ? -1 : Number(a > b)
  }
  const text = (value: Text) => {
    if ("value" in value) return value.value
    if (!options.loadText) throw new Error(`Text ${value.id} is unavailable`)
    return options.loadText(value.id)
  }
  const keys = (value: object): readonly string[] => {
    const array = Array.isArray(value), own = Object.keys(value), prototype: unknown = Object.getPrototypeOf(value)
    if (array ? prototype !== Array.prototype || own.length !== value.length || own.some((key, index) => key !== String(index)) : prototype !== Object.prototype && prototype !== null) throw new TypeError("State requires plain JSON containers")
    if (Reflect.ownKeys(value).length !== own.length + Number(array) || own.some(key => !("value" in Object.getOwnPropertyDescriptor(value, key)!))) throw new TypeError("State requires enumerable JSON data")
    return own
  }
  const from = (input: unknown, previous?: Value, visiting = new Set<object>()): Value => {
    if (input === null || typeof input === "boolean") return input
    if (typeof input === "number" && Number.isFinite(input)) return Object.is(input, -0) ? 0 : input
    if (typeof input === "string") {
      if (typeof previous === "object" && previous?.type === "text" && text(previous) === input) return previous
      if (Buffer.byteLength(input) <= inlineBytes) return input
      const result: Text = Object.freeze({ type: "text", value: input }); options.allocatedText?.(result); return result
    }
    if (typeof input !== "object" || visiting.has(input)) throw new TypeError("State requires acyclic JSON")
    const cached = known.get(input)
    if (cached !== undefined) {
      if (previous !== undefined && options.equivalent?.(cached, previous)) { known.set(input, previous); return previous }
      return cached
    }
    const own = keys(input), array = Array.isArray(input), type = array ? "array" : "object"
    const remember = (value: Value) => { if (Object.isFrozen(input) && own.every(key => { const child = (input as Readonly<Record<string, unknown>>)[key]; return child === null || typeof child !== "object" || known.has(child) })) known.set(input, value); return value }
    const before = typeof previous === "object" && previous?.type === type ? previous : undefined
    visiting.add(input)
    try {
      if (array) {
        const old = before ? [...pages.scan(before.root)].map(([, value]) => value) : []
        const values = (input as readonly unknown[]).map((value, index) => from(value, old[index], visiting))
        let prefix = 0, suffix = 0
        while (prefix < Math.min(old.length, values.length) && Object.is(old[prefix], values[prefix])) prefix++
        while (suffix < Math.min(old.length, values.length) - prefix && Object.is(old[old.length - suffix - 1], values[values.length - suffix - 1])) suffix++
        if (before && prefix === old.length && prefix === values.length) return remember(before)
        if (!before) return remember(container(type, pages.from(values.map(value => [null, value]))))
        const [left, tail] = pages.split(before.root, prefix), [, right] = pages.split(tail, old.length - prefix - suffix)
        return remember(container(type, pages.join(pages.join(left, pages.from(values.slice(prefix, values.length - suffix).map(value => [null, value]))), right)))
      }
      const fields = input as Readonly<Record<string, unknown>>, names = new Set(own)
      if (!before) { const order = new Map(own.map((key, index) => [key, index])); return remember(container(type, pages.from([...own].sort().map(key => [key, field(from(fields[key], undefined, visiting), order.get(key)!)])), own.length)) }
      let root = before.root
      const order = new Map(own.map((key, index) => [key, index]))
      if (before) for (const [key] of pages.scan(before.root)) if (!names.has(key as string)) root = pages.remove(root, pages.seek(root, key, compare).index)
      for (const key of [...own].sort()) {
        const at = pages.seek(root, key, compare), old = at.found ? pages.get(root, at.index)[1] as Field : undefined
        const value = from(fields[key], old?.value, visiting)
        if (!at.found) root = pages.insert(root, at.index, [key, field(value, order.get(key)!)])
        else if (!Object.is(value, old!.value) || old!.order !== order.get(key)) root = pages.set(root, at.index, [key, field(value, order.get(key)!)])
      }
      return remember(before?.root === root ? before : container(type, root, own.length))
    } finally { visiting.delete(input) }
  }
  const child = (value: Value, key: string | number): Value | undefined => {
    if (value === null || typeof value !== "object" || (value.type === "text" || value.type === "field")) throw new TypeError("Path traverses a scalar")
    if (value.type === "array") {
      if (!Number.isSafeInteger(key) || typeof key !== "number" || key < 0) throw new TypeError("Array path requires a nonnegative integer")
      return key < value.root.count ? pages.get(value.root, key)[1] : undefined
    }
    if (typeof key !== "string") throw new TypeError("Object path requires a string")
    const at = pages.seek(value.root, key, compare)
    return at.found ? (pages.get(value.root, at.index)[1] as Field).value : undefined
  }
  const select = (value: Value, path: Path): Value => {
    let current = value
    for (const key of path) {
      const next = child(current, key)
      if (next === undefined) throw new Error("Missing JSON path")
      current = next
    }
    return current
  }
  const materialize = (value: Value): Json => {
    if (value === null || typeof value !== "object") return value
    if (value.type === "text") return text(value)
    if (value.type === "field") return materialize(value.value)
    const result = Object.freeze(value.type === "array" ? [...pages.scan(value.root)].map(([, value]) => materialize(value)) : Object.fromEntries([...pages.scan(value.root)].sort((a, b) => (a[1] as Field).order - (b[1] as Field).order).map(([key, value]) => [key, materialize(value)])))
    known.set(result, value); return freezeJson(result)
  }
  const array = (value: Value): Container => {
    if (typeof value !== "object" || value?.type !== "array") throw new TypeError("Operation requires an array")
    return value
  }
  const view = <State extends Json = Json>(root: () => Value): View<State> => ({
    read: ((path: Path) => { options.materialized?.(); return materialize(select(root(), path)) }) as View<State>["read"],
    has: path => {
      let current: Value | undefined = root()
      for (const key of path) { if (current === undefined) return false; current = child(current, key) }
      return current !== undefined
    },
    length: path => array(select(root(), path)).root.count,
    slice: (path, start, end) => Object.freeze([...pages.scan(array(select(root(), path)).root, start, end)].map(([, value]) => materialize(value))),
  })
  const change = (value: Value, path: Path, update: (value: Value) => Value, depth = 0): Value => {
    if (depth === path.length) return update(value)
    const key = path[depth]!, old = child(value, key)
    if (old === undefined) throw new Error("Missing JSON path")
    const next = change(old, path, update, depth + 1)
    if (Object.is(old, next)) return value
    const parent = value as Container, at = parent.type === "array" ? key as number : pages.seek(parent.root, key as string, compare).index
    return container(parent.type, pages.set(parent.root, at, [parent.type === "array" ? null : key as string, parent.type === "array" ? next : field(next, (pages.get(parent.root, at)[1] as Field).order)]), parent.next)
  }
  const edit = (root: Value, callback: (editor: Editor) => void): Value => {
    let current = root, active = true
    const guard = () => { if (!active) throw new Error("Editor expired") }
    const splice = (path: Path, start: number, count: number, items: readonly Json[]) => {
      guard()
      current = change(current, path, value => {
        const before = array(value)
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 0 || start + count > before.root.count) throw new RangeError("Invalid splice range")
        if (!Array.isArray(items)) throw new TypeError("Splice items must be an array")
        const inserted = from(items) as Container
        if (!count && !inserted.root.count) return before
        const [left, tail] = pages.split(before.root, start), [, right] = pages.split(tail, count)
        return container("array", pages.join(pages.join(left, inserted.root), right))
      })
    }
    const editor: Editor = {
      ...view(() => { guard(); return current }),
      set: (path, input) => {
        guard()
        if (!path.length) { current = from(input, current); return }
        const key = path.at(-1)!
        current = change(current, path.slice(0, -1), value => {
          const old = child(value, key), parent = value as Container, next = from(input, old)
          if (Object.is(old, next)) return parent
          if (parent.type === "array") {
            if (old === undefined) throw new Error("Array set requires an existing index")
            return container("array", pages.set(parent.root, key as number, [null, next]))
          }
          const at = pages.seek(parent.root, key as string, compare)
          return container("object", at.found ? pages.set(parent.root, at.index, [key as string, field(next, (pages.get(parent.root, at.index)[1] as Field).order)]) : pages.insert(parent.root, at.index, [key as string, field(next, parent.next!)]), parent.next! + Number(!at.found))
        })
      },
      remove: path => {
        guard()
        const key = path.at(-1)
        if (typeof key !== "string") throw new TypeError("Remove requires an object property")
        current = change(current, path.slice(0, -1), value => {
          child(value, key)
          const parent = value as Container, at = pages.seek(parent.root, key, compare)
          return at.found ? container("object", pages.remove(parent.root, at.index), parent.next) : parent
        })
      },
      append: (path, items) => { guard(); splice(path, array(select(current, path)).root.count, 0, items) },
      splice,
    }
    try {
      const result: unknown = callback(editor)
      if (result !== undefined) throw new TypeError("Edit callback must return undefined")
      return current
    } finally { active = false; current = null }
  }
  const reduce = (root: Value, callback: (state: Json) => unknown): Value => {
    options.materialized?.(); return from(callback(materialize(root)), root)
  }
  const reconcile = (root: Value, before: Json, after: unknown) => from(after, before !== null && typeof before === "object" ? known.get(before) ?? root : root)
  return { pages, inlineBytes, from, reconcile, select, materialize, view, edit, reduce, text, forget: () => { known = new WeakMap() } }
}
