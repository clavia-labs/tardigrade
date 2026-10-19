import type { Json } from "./state"

const known = new WeakSet<object>()
export const DEFAULT_PACK_BYTES = 4096
export type Cell = { readonly kind: "value" | "array" | "object" | "entry"; readonly value: Json }
export type Changes = ReadonlyMap<string, Cell | null>

// freeze preserves shared JSON identities and rejects values that cannot round-trip through JSON (test/reducer/properties.test.ts).
export function freeze(input: unknown, visiting = new Set<object>()): Json {
  if (input === null || typeof input === "string" || typeof input === "boolean") return input
  if (typeof input === "number" && Number.isFinite(input)) return input === 0 ? 0 : input
  if (typeof input !== "object" || input === null || visiting.has(input)) throw new Error("State requires acyclic plain JSON")
  if (known.has(input)) return input as Json
  const array = Array.isArray(input), keys = Object.keys(input), prototype: unknown = Object.getPrototypeOf(input)
  if (array ? prototype !== Array.prototype || keys.length !== input.length || keys.some((key, i) => key !== String(i)) : prototype !== Object.prototype && prototype !== null) throw new Error("State requires plain JSON containers")
  if (Reflect.ownKeys(input).length !== keys.length + Number(array)) throw new Error("State requires enumerable string keys")
  visiting.add(input)
  const values = keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!
    if (!("value" in descriptor)) throw new Error("State cannot contain accessors")
    return freeze(descriptor.value, visiting)
  })
  visiting.delete(input)
  const unchanged = keys.every((key, i) => Object.is(Object.getOwnPropertyDescriptor(input, key)!.value, values[i]))
  const value = unchanged ? input : array ? values : Object.fromEntries(keys.map((key, i) => [key, values[i]]))
  Object.freeze(value); known.add(value)
  return value as Json
}

const keys = (value: Json): (string | number)[] => Array.isArray(value) ? Array.from(value.keys()) : Object.keys(value as object)
const child = (value: Json, key: string | number) => (value as { readonly [key: string | number]: Json })[key]!
const equal = (a: Json, b: Json): boolean => {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false
  const left = keys(a), right = keys(b)
  return left.length === right.length && left.every((key, i) => key === right[i] && equal(child(a, key), child(b, key)))
}

// makeReconciler packs small array-free objects and skips shared subtrees without serialising whole unchanged objects (test/reducer/properties.test.ts).
export function makeReconciler(packBytes = DEFAULT_PACK_BYTES) {
  if (!Number.isSafeInteger(packBytes) || packBytes < 0) throw new Error("packBytes must be a nonnegative safe integer")
  const sizes = new WeakMap<object, number>()
  const layouts = new WeakMap<readonly Json[], readonly string[]>()
  let visitedValues = 0, arrayEntriesVisited = 0
  const layout = (value: readonly Json[], before?: readonly Json[]): readonly string[] => {
    const known = layouts.get(value)
    if (known) return known
    const old = before ? layout(before) : []
    const available = new Map<Json, string[]>()
    for (let i = (before?.length ?? 0) - 1; i >= 0; i--) {
      arrayEntriesVisited++
      const item = before![i]!, queue = available.get(item) ?? []
      queue.push(old[i]!); available.set(item, queue)
    }
    const matched = value.map(item => { arrayEntriesVisited++; return available.get(item)?.pop() })
    const used = new Set(matched.filter(id => id !== undefined))
    const ids = matched.map((id, i) => {
      arrayEntriesVisited++
      const next = id ?? (old[i] && !used.has(old[i]!) ? old[i]! : crypto.randomUUID())
      used.add(next); return next
    })
    layouts.set(value, ids); return ids
  }
  const size = (value: Json): number => {
    if (value === null) return 4
    if (typeof value === "boolean") return value ? 4 : 5
    if (typeof value === "number") return String(value).length
    if (typeof value === "string") return value.length + 2 > packBytes ? Infinity : Buffer.byteLength(JSON.stringify(value))
    if (Array.isArray(value)) return Infinity
    const cached = sizes.get(value)
    if (cached !== undefined) return cached
    let bytes = 2, count = 0
    for (const key in value) if (Object.hasOwn(value, key)) {
      bytes += Number(count++ > 0) + size(key) + 1 + size(child(value, key))
      if (bytes > packBytes) break
    }
    sizes.set(value, bytes); return bytes
  }
  const kind = (value: Json): Cell["kind"] => Array.isArray(value) ? "array" : value !== null && typeof value === "object" && size(value) > packBytes ? "object" : "value"
  const shape = (value: Json): Cell => ({ kind: kind(value), value: Array.isArray(value) ? { head: layout(value)[0] ?? null, length: value.length } : kind(value) === "object" ? Object.keys(value as object) : value })
  const reconcile = (before: Json | undefined, after: Json): Changes => {
    const rows = new Map<string, Cell | null>()
    const whole = (value: Json, path: readonly (string | number)[], remove: boolean) => {
      visitedValues++
      rows.set(JSON.stringify(path), remove ? null : shape(value))
      if (Array.isArray(value)) {
        const ids = layout(value)
        for (const [i, id] of ids.entries()) {
          arrayEntriesVisited++
          rows.set(JSON.stringify([...path, id]), remove ? null : { kind: "entry", value: ids[i + 1] ?? null })
          whole(value[i]!, [...path, id, "value"], remove)
        }
      } else if (kind(value) === "object") for (const key of keys(value)) whole(child(value, key), [...path, key], remove)
    }
    const visit = (a: Json | undefined, b: Json, path: readonly (string | number)[]) => {
      visitedValues++
      if (Object.is(a, b)) return
      const tag = kind(b)
      if (a === undefined || kind(a) !== tag) {
        if (a !== undefined) whole(a, path, true)
        whole(b, path, false); return
      }
      if (tag === "value") { if (!equal(a, b)) rows.set(JSON.stringify(path), shape(b)); return }
      if (Array.isArray(a) && Array.isArray(b)) {
        const old = layout(a), next = layout(b, a), positions = new Map<string, number>(), keep = new Set(next)
        for (const [i, id] of old.entries()) { arrayEntriesVisited++; positions.set(id, i) }
        if (a.length !== b.length || old[0] !== next[0]) rows.set(JSON.stringify(path), shape(b))
        for (const [i, id] of old.entries()) {
          arrayEntriesVisited++
          if (!keep.has(id)) { rows.set(JSON.stringify([...path, id]), null); whole(a[i]!, [...path, id, "value"], true) }
        }
        for (const [i, id] of next.entries()) {
          arrayEntriesVisited++
          const previous = positions.get(id), link = next[i + 1] ?? null
          if (previous === undefined || (old[previous + 1] ?? null) !== link) rows.set(JSON.stringify([...path, id]), { kind: "entry", value: link })
          visit(previous === undefined ? undefined : a[previous]!, b[i]!, [...path, id, "value"])
        }
        return
      }
      const oldKeys = keys(a), newKeys = keys(b)
      if (oldKeys.length !== newKeys.length || oldKeys.some((key, i) => key !== newKeys[i])) rows.set(JSON.stringify(path), shape(b))
      for (const key of oldKeys) if (!Object.hasOwn(b as object, key)) whole(child(a, key), [...path, key], true)
      for (const key of newKeys) visit(Object.hasOwn(a as object, key) ? child(a, key) : undefined, child(b, key), [...path, key])
    }
    visit(before, after, []); return rows
  }
  return Object.assign(reconcile, {
    restore: (rows: ReadonlyMap<string, Cell>) => restore(rows, (value, ids) => layouts.set(value, ids)),
    stats: () => ({ visitedValues, arrayEntriesVisited }),
  })
}

// restore rebuilds a complete JSON tree from its path rows (test/reducer/properties.test.ts).
function restore(rows: ReadonlyMap<string, Cell>, onArray?: (value: readonly Json[], ids: readonly string[]) => void): Json {
  const visit = (path: readonly (string | number)[]): Json => {
    const row = rows.get(JSON.stringify(path))
    if (!row) throw new Error("Missing state path")
    if (row.kind === "value") return row.value
    if (row.kind === "array") {
      const descriptor = row.value as { readonly head: Json; readonly length: Json }
      if (descriptor === null || typeof descriptor !== "object" || typeof descriptor.length !== "number" || !Number.isSafeInteger(descriptor.length) || descriptor.length < 0 || descriptor.length > rows.size) throw new Error("Invalid array descriptor")
      let next = descriptor.head
      const value: Json[] = [], ids: string[] = [], seen = new Set<string>()
      while (next !== null) {
        if (typeof next !== "string" || seen.has(next) || value.length >= descriptor.length) throw new Error("Invalid array links")
        seen.add(next); ids.push(next)
        const entry = rows.get(JSON.stringify([...path, next]))
        if (entry?.kind !== "entry") throw new Error("Missing array entry")
        value.push(visit([...path, next, "value"])); next = entry.value
      }
      if (value.length !== descriptor.length) throw new Error("Missing array elements")
      const array = freeze(value) as readonly Json[]
      onArray?.(array, ids); return array
    }
    if (row.kind !== "object") throw new Error("Invalid state row kind")
    if (!Array.isArray(row.value) || row.value.some(key => typeof key !== "string") || new Set(row.value).size !== row.value.length) throw new Error("Invalid object keys")
    return Object.fromEntries((row.value as readonly string[]).map(key => [key, visit([...path, key])]))
  }
  return freeze(visit([]))
}
