import { Chunk, HashMap, HashSet } from "effect"

// validateView rejects executable values and accessors without evaluating them (data.test.ts).
export const validateView = (view: unknown): void => {
  const seen = new WeakSet<object>()
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "function")
      throw new TypeError(`${path} contains executable behavior; expose it as an interaction or transition`)
    if (value === null || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    let intrinsic: object | undefined
    if (value instanceof Date) intrinsic = Date.prototype
    if (value instanceof Map) {
      for (const [key, entry] of Map.prototype.entries.call(value)) {
        visit(key, `${path}.key`)
        visit(entry, `${path}.value`)
      }
      intrinsic = Map.prototype
    } else if (value instanceof Set) {
      for (const entry of Set.prototype.values.call(value)) visit(entry, `${path}.value`)
      intrinsic = Set.prototype
    } else if (HashMap.isHashMap(value)) {
      // TODO: Check attached properties on Effect collections and traverse with trusted iterators without invoking accessors.
      for (const [key, entry] of value) {
        visit(key, `${path}.key`)
        visit(entry, `${path}.value`)
      }
      return
    } else if (HashSet.isHashSet(value) || Chunk.isChunk(value)) {
      for (const entry of value) visit(entry, `${path}.value`)
      return
    }
    let current: object | null = value
    while (current !== null && current !== Object.prototype && current !== Array.prototype && current !== intrinsic) {
      for (const key of Reflect.ownKeys(current)) {
        if (current !== value && key === "constructor") continue
        const descriptor = Object.getOwnPropertyDescriptor(current, key)!
        if (descriptor.get !== undefined || descriptor.set !== undefined)
          throw new TypeError(`${path}.${String(key)} contains an accessor; views must expose data`)
        visit(descriptor.value, `${path}.${String(key)}`)
      }
      current = Object.getPrototypeOf(current) as object | null
    }
  }
  visit(view, "view")
}
