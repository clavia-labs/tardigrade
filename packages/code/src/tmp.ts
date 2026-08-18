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

// SpillPolicy is the bound and what a bounded value shows: a JSON value longer than
// `spillBytes` goes to tmp and the event keeps a pointer with the first `previewChars` of it.
// The reactor that applies it takes an override (execute.ts, codeReactorFor), because the right
// bound is the consumer's context window and storage, not this module's guess.
export interface SpillPolicy {
  readonly spillBytes: number
  readonly previewChars: number
}

export const DEFAULT_SPILL_POLICY: SpillPolicy = { spillBytes: 8_192, previewChars: 500 }

export const spillPolicyOf = (policy: Partial<SpillPolicy> = {}): SpillPolicy => ({
  spillBytes: policy.spillBytes ?? DEFAULT_SPILL_POLICY.spillBytes,
  previewChars: policy.previewChars ?? DEFAULT_SPILL_POLICY.previewChars
})

// tmpPointer is the pointer a bounded value leaves behind. `size` is the whole value's length,
// so the reader sees how much the preview left out.
export const tmpPointer = (ref: string, size: number, preview: string) => ({
  tmp: ref,
  size,
  preview,
  note: `full value: workspace.read({ref: '${ref}'}), search it: workspace.grep({pattern, ref: '${ref}'})`
})
