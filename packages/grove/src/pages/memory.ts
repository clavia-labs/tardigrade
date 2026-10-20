import type { Instance } from "../document"
import type { ValueReference } from "../value"
import { Schema } from "effect"
import { encodeReference, referenceLocator } from "../value"
import { localOwners } from "../session/ownership"
import { documents, type Value } from "./document"
import { session } from "./session"
import type { PageOptions } from "./storage"

export const DEFAULT_MEMORY_SCOPE = "tardigrade/memory"

// memory keeps JSON page roots alive through document handles and projection holders (core/properties/durable-state.test.ts).
export function memory(options: PageOptions & { readonly scope?: string } = {}): Pick<Instance, "bind" | "capture" | "stats" | "bytes" | "view" | "hold" | "release" | "read" | "discard" | "clear"> {
  const scope = options.scope ?? DEFAULT_MEMORY_SCOPE, pages = documents(options)
  const roots = new Map<string, WeakRef<{ readonly value: Value }>>(), pending = new Map<string, { readonly value: Value }>()
  const root = (id: string) => {
    const cell = roots.get(id)?.deref()
    if (!cell) throw new Error("Memory document expired or missing")
    return cell
  }
  const held = localOwners<{ readonly reference: ValueReference<unknown>; readonly cell: object }>(entry => encodeReference(entry.reference))
  const stage = (value: Value) => { const id = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""); const cell = { value }; roots.set(id, new WeakRef(cell)); pending.set(id, cell); return id }
  const author = session({ engine: pages, scope, root: id => root(id).value, anchor: root,
    stage,
    readLegacy: () => { throw new Error("Memory Grove cannot read persisted references") },
  })
  const view: Instance["view"] = (ref, schema) => author.values.view(ref, schema)
  const read = (ref: ValueReference<unknown>) => view(ref, Schema.Json).materialize()
  return {
    bind: author.bind, capture: value => author.values.reference(author.register(stage(pages.from(value)))),
    view, read, bytes: ref => Buffer.byteLength(JSON.stringify(read(ref))),
    hold: (holder, name, reference) => held.hold(holder, name, { reference, cell: root(referenceLocator(reference, scope).root) }),
    release: holder => { held.release(holder); pending.clear(); for (const [id, ref] of roots) if (!ref.deref()) roots.delete(id) },
    discard: () => pending.clear(), clear: () => pending.clear(),
    stats: () => ({ loadedNodes: 0, loadedBytes: 0, hits: 0, evictions: 0, cachedBytes: 0, cachedNodes: 0, cacheBudgetBytes: 0, stagedNodes: pending.size, loadedRows: 0, loadedRowBytes: 0, stagedRows: 0, rowBatchItems: 0, loadedMapValues: 0, loadedMapBytes: 0, stagedMapEntries: 0 }),
  }
}
