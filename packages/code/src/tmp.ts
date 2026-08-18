import { Context, Effect } from "effect"

// Tmp is the spill seam: content bounded out of an agent's turn context lands in the family workspace's
// `tmp` table, keyed by ref, and every truncation carries a pointer with a CTA. The event keeps
// a preview and the ref; replay hydrates the ref from the same durable storage, so recorded
// pairs stay whole. Agents reach the full value through workspace.sql.
export interface TmpService {
  readonly store: (ref: string, json: string) => Effect.Effect<void>
  readonly load: (ref: string) => Effect.Effect<string | undefined>
}

// memoryTmpService holds spilled values in a Map: replay hydrates from it for the life of the
// process. Each call is a fresh store; the Reference default below is one shared store, so two
// hosts in one process share it (refs are unique, so rows never collide).
export const memoryTmpService = (): TmpService => {
  const store = new Map<string, string>()
  return {
    store: (ref: string, json: string) => Effect.sync(() => void store.set(ref, json)),
    load: (ref: string) => Effect.sync(() => store.get(ref))
  }
}

export const Tmp: Context.Reference<TmpService> = Context.Reference("code/Tmp", {
  defaultValue: memoryTmpService
})

// TMP_BYTES is the bound: a larger value goes to tmp and the event keeps a pointer.
export const TMP_BYTES = 8_192

// tmpPointer is the pointer a bounded value leaves behind.
export const tmpPointer = (ref: string, size: number, preview: string) => ({
  tmp: ref,
  size,
  preview,
  note: `full value: workspace.read({ref: '${ref}'}), search it: workspace.grep({pattern, ref: '${ref}'})`
})
