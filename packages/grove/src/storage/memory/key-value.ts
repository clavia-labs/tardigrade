import type { MapEntry, MapSpan, MapWriter } from "../../collections/key-value"

export function memoryMaps(): MapWriter {
  const manifests = new Map<string, readonly MapSpan[]>(), heads = new Map<string, number>(), rows = new Map<string, Map<string, Map<number, { readonly entry: MapEntry; readonly text: string | null }>>>()
  const entry = (branch: string, revision: number, key: string) => [...(rows.get(branch)?.get(key)?.values() ?? [])].filter(row => row.entry.revision <= revision).sort((a, b) => b.entry.revision - a.entry.revision)[0]?.entry
  return {
    manifest: hash => manifests.get(hash), head: branch => heads.get(branch) ?? 0, entry,
    entries: (branch, revision, after, limit) => [...(rows.get(branch)?.keys() ?? [])].filter(key => after === undefined || key > after).sort().flatMap(key => { const found = entry(branch, revision, key); return found ? [found] : [] }).slice(0, limit),
    value: entry => { const text = rows.get(entry.branch)?.get(entry.key)?.get(entry.revision)?.text; if (text === undefined || text === null) throw new Error("Missing in-memory key-value revision"); return text },
    insert: (branch, revision, key, change) => {
      let keys = rows.get(branch); if (!keys) { keys = new Map(); rows.set(branch, keys) }
      let versions = keys.get(key); if (!versions) { versions = new Map(); keys.set(key, versions) }
      const existing = versions.get(revision)
      if (existing) { if (existing.text !== change.text || existing.entry.order !== change.order) throw new Error("Conflicting key-value revision"); return false }
      versions.set(revision, { text: change.text, entry: { branch, key, revision, order: change.order, bytes: change.text === null ? 0 : Buffer.byteLength(change.text), deleted: change.text === null } })
      heads.set(branch, Math.max(heads.get(branch) ?? 0, revision))
      return true
    },
    publish: (hash, spans) => { manifests.set(hash, spans) },
  }
}
