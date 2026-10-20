import { btree, type Page } from "./btree"
import { sequence, type Sequence } from "./sequence"

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }
export type JsonNode = null | boolean | number | string
  | { readonly type: "object"; readonly fields: Page<string, JsonNode> }
  | { readonly type: "array"; readonly elements: Sequence<JsonNode> }
export type Path = readonly (string | number)[]

export function document(options: { readonly capacity?: number } = {}) {
  const objects = btree<string, JsonNode>((left, right) => left < right ? -1 : left > right ? 1 : 0, options)
  const arrays = sequence<JsonNode>(options)
  const object = (fields: Page<string, JsonNode>): JsonNode => Object.freeze({ type: "object", fields })
  const array = (elements: Sequence<JsonNode>): JsonNode => Object.freeze({ type: "array", elements })
  const from = (value: Json): JsonNode => {
    const ancestors = new Set<object>()
    const encode = (input: Json): JsonNode => {
      if (input === null || typeof input === "boolean" || typeof input === "string") return input
      if (typeof input === "number" && Number.isFinite(input)) return input
      if (typeof input !== "object" || input === null) throw new TypeError("value must be JSON")
      if (ancestors.has(input)) throw new TypeError("JSON must be acyclic")
      ancestors.add(input)
      try {
        if (Array.isArray(input)) return array(arrays.from(Array.from(input, item => encode(item))))
        const prototype: unknown = Object.getPrototypeOf(input)
        if (prototype !== Object.prototype && prototype !== null) throw new TypeError("JSON objects must have plain prototypes")
        let fields = objects.empty()
        for (const key of Object.keys(input)) fields = objects.set(fields, key, encode((input as { readonly [key: string]: Json })[key]!))
        return object(fields)
      } finally { ancestors.delete(input) }
    }
    return encode(value)
  }
  const child = (node: JsonNode, key: string | number): JsonNode | undefined => {
    if (typeof node !== "object" || node === null) throw new TypeError("path traverses a scalar")
    if (node.type === "object" && typeof key === "string") return objects.get(node.fields, key)
    if (node.type === "array" && typeof key === "number") return arrays.get(node.elements, key)
    throw new TypeError("path segment does not match container")
  }
  const get = (root: JsonNode, path: Path): JsonNode | undefined => {
    let node: JsonNode | undefined = root
    for (const key of path) {
      if (node === undefined) return undefined
      node = child(node, key)
    }
    return node
  }
  const update = (node: JsonNode, path: Path, change: (current: JsonNode | undefined) => JsonNode | undefined, depth = 0): JsonNode | undefined => {
    if (depth === path.length) return change(node)
    const key = path[depth]!, previous = child(node, key)
    if (depth + 1 !== path.length && previous === undefined) throw new RangeError("path parent does not exist")
    const next = depth + 1 === path.length ? change(previous) : update(previous!, path, change, depth + 1)
    if (Object.is(previous, next)) return node
    if (typeof node !== "object" || node === null) throw new TypeError("path traverses a scalar")
    if (node.type === "object" && typeof key === "string") return object(next === undefined ? objects.delete(node.fields, key) : objects.set(node.fields, key, next))
    if (node.type === "array" && typeof key === "number" && next !== undefined) return array(arrays.set(node.elements, key, next))
    throw new TypeError("remove applies to object fields")
  }
  const materialize = (node: JsonNode): Json => {
    if (typeof node !== "object" || node === null) return node
    if (node.type === "array") return Array.from(arrays.scan(node.elements), materialize)
    return Object.fromEntries(Array.from(objects.scan(node.fields), ([key, value]) => [key, materialize(value)]))
  }
  const splice = (root: JsonNode, path: Path, start: number, deleteCount: number, items: readonly Json[] = []): JsonNode => {
    const values = Array.from(items, from)
    return update(root, path, current => {
      if (typeof current !== "object" || current === null || current.type !== "array") throw new TypeError("splice requires an array")
      const next = arrays.splice(current.elements, start, deleteCount, values)
      return next === current.elements ? current : array(next)
    })!
  }
  return {
    capacity: objects.capacity, from, get, materialize,
    set: (root: JsonNode, path: Path, value: Json): JsonNode => {
      const next = from(value)
      return update(root, path, () => next)!
    },
    remove: (root: JsonNode, path: Path): JsonNode => {
      if (path.length === 0 || typeof path.at(-1) !== "string") throw new TypeError("remove requires an object field path")
      return update(root, path, () => undefined)!
    },
    splice,
    append: (root: JsonNode, path: Path, items: readonly Json[]): JsonNode => {
      const node = get(root, path)
      if (typeof node !== "object" || node === null || node.type !== "array") throw new TypeError("append requires an array")
      return splice(root, path, node.elements.count, 0, items)
    },
    elements: (node: JsonNode, start?: number, end?: number): IterableIterator<JsonNode> => {
      if (typeof node !== "object" || node === null || node.type !== "array") throw new TypeError("elements requires an array")
      return arrays.scan(node.elements, start, end)
    },
    fields: (node: JsonNode): IterableIterator<readonly [string, JsonNode]> => {
      if (typeof node !== "object" || node === null || node.type !== "object") throw new TypeError("fields requires an object")
      return objects.scan(node.fields)
    },
  }
}
