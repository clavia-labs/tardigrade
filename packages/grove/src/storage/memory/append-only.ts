import type { LogSpan, RowWriter } from "../../collections/append-only"

export const memoryRows = (): RowWriter => {
  const manifests = new Map<string, readonly LogSpan[]>(), rows = new Map<string, Map<number, string>>()
  return {
    manifest: hash => manifests.get(hash),
    length: log => rows.get(log)?.size ?? 0,
    read: (log, start, end) => Array.from({ length: end - start }, (_, index) => {
      const text = rows.get(log)?.get(start + index)
      if (text === undefined) throw new Error("Missing in-memory log row")
      return text
    }),
    insert: (log, index, text) => { let values = rows.get(log); if (!values) { values = new Map(); rows.set(log, values) }; const previous = values.get(index); if (previous !== undefined && previous !== text) throw new Error("Conflicting log row"); values.set(index, text) },
    publish: (hash, spans) => { manifests.set(hash, spans) },
  }
}
