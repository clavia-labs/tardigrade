export const DEFAULT_READ_CACHE_BYTES = 32 * 1024 * 1024

// makeCache shares an encoded-byte budget between immutable node, row-page and manifest decodings (test/collections/append-only.test.ts; test/storage.test.ts).
export function makeCache(budget: number) {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error("Invalid Grove read cache budget")
  const entries = new Map<string, { readonly value: unknown; readonly bytes: number }>()
  let bytes = 0, hits = 0, evictions = 0
  const remove = (key: string) => { const entry = entries.get(key); if (entry) { bytes -= entry.bytes; entries.delete(key) } }
  return {
    get: <Value>(key: string): Value | undefined => {
      const entry = entries.get(key)
      if (!entry) return undefined
      entries.delete(key); entries.set(key, entry); hits++
      return entry.value as Value
    },
    set: (key: string, value: unknown, cost: number) => {
      remove(key)
      if (cost > budget) return
      while (entries.size && bytes + cost > budget) { remove(entries.keys().next().value!); evictions++ }
      entries.set(key, { value, bytes: cost }); bytes += cost
    },
    remove,
    clear: () => { entries.clear(); bytes = 0 },
    stats: () => ({ hits, evictions, cachedNodes: entries.size, cachedBytes: bytes, cacheBudgetBytes: budget }),
  }
}
export type ReadCache = ReturnType<typeof makeCache>
