import { Effect } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"

// The workspace store is Effect's KeyValueStore. Its manifest contract lives here, with spill and
// hydrate as its writers: content bounded out of an agent's turn context lands in
// the store keyed by ref, and every truncation carries a pointer with a CTA. The event keeps a
// preview and the ref; replay hydrates the ref from the same store, so recorded pairs stay whole.
// The platform picks the backend (a memory store, a file system, any SqlClient) and picks what one
// workspace spans by handing the lane a prefixed view.

// WORKSPACE_REFS is the reserved key the ref manifest lives under. The value is a JSON array of ref
// strings, and a missing key reads as the empty array. The KeyValueStore interface has no
// enumeration, so the spill path maintains the index inside the store; a platform-native lister
// honors the same key.
export const WORKSPACE_REFS = "ws:refs"

// A manifest that is missing, unparseable, or not an array of strings reads as empty: the index is
// derived convenience over the values, and refusing to answer would strand every ref behind one bad
// write.
const decodeRefs = (raw: string | undefined): ReadonlyArray<string> => {
  if (raw === undefined) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((r): r is string => typeof r === "string")
  } catch {
    return []
  }
}

// spill writes one value and adds its ref to the manifest. The add is idempotent, so a crashed
// retry of the same keyed spill leaves one entry (spill.test.ts, W2). The value is written before
// the manifest: a ref the manifest names must be readable, and a value the manifest misses is still
// reachable by ref.
export const spill = (
  ref: string,
  json: string
): Effect.Effect<void, KeyValueStore.KeyValueStoreError, KeyValueStore.KeyValueStore> =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore
    yield* store.set(ref, json)
    // `modify` is the store's read-modify-write, and it answers undefined when the key is absent:
    // that answer is the cue to seed the manifest with this first ref.
    const updated = yield* store.modify(WORKSPACE_REFS, (current) => {
      const held = decodeRefs(current)
      return held.includes(ref) ? current : JSON.stringify([...held, ref])
    })
    if (updated === undefined) yield* store.set(WORKSPACE_REFS, JSON.stringify([ref]))
  })

// hydrate reads one spilled value back. A ref absent from the store reads as undefined, so a caller
// distinguishes "never spilled" from "spilled empty" (spill.test.ts, W1).
export const hydrate = (
  ref: string
): Effect.Effect<string | undefined, KeyValueStore.KeyValueStoreError, KeyValueStore.KeyValueStore> =>
  Effect.flatMap(KeyValueStore.KeyValueStore, (store) => store.get(ref))

// refs reads the manifest: the refs this store holds, in the order they were spilled.
// refs is callable because @clavia/tardigrade-code/store exposes that shape to consumers.
// @effect-diagnostics-next-line lazyEffect:off
export const refs = (): Effect.Effect<
  ReadonlyArray<string>,
  KeyValueStore.KeyValueStoreError,
  KeyValueStore.KeyValueStore
> => Effect.map(Effect.flatMap(KeyValueStore.KeyValueStore, (store) => store.get(WORKSPACE_REFS)), decodeRefs)

// SpillPolicy is the bound and what a bounded value shows: a JSON value longer than `spillBytes`
// goes to the store and the event keeps a pointer with the first `previewChars` of it. `note`
// renders the pointer's call to action. The reactor that applies the policy takes an override
// (execute.ts, codeReactorFor), because the consumer owns the context window, storage, and verbs
// in scope (execute.test.ts, "the pointer's note").
export interface SpillPolicy {
  readonly spillBytes: number
  readonly previewChars: number
  readonly note: (ref: string) => string
}

// WORKSPACE_SPILL_NOTE names the workspace package's read and grep verbs (workspace.ts).
// codeReactorFor refuses a scope where this note would lie
// (execute.ts; workspace.test.ts, "the default pointer note names verbs this package answers").
export const WORKSPACE_SPILL_NOTE = (ref: string): string =>
  `full value: workspace.read({ref: '${ref}'}), search it: workspace.grep({pattern, ref: '${ref}'})`

// BARE_SPILL_NOTE states the ref and no verb, for a scope that mounts no workspace package: a
// pointer must never name a call the scope cannot answer (execute.test.ts, "the pointer's note").
export const BARE_SPILL_NOTE = (ref: string): string =>
  `full value stored under ref '${ref}'; this scope mounts no reader for it, so work from the preview`

export const DEFAULT_SPILL_POLICY: SpillPolicy = { spillBytes: 8_192, previewChars: 500, note: WORKSPACE_SPILL_NOTE }

export const spillPolicyOf = (policy: Partial<SpillPolicy> = {}): SpillPolicy => ({
  spillBytes: policy.spillBytes ?? DEFAULT_SPILL_POLICY.spillBytes,
  previewChars: policy.previewChars ?? DEFAULT_SPILL_POLICY.previewChars,
  note: policy.note ?? DEFAULT_SPILL_POLICY.note
})

// spillPointer is the pointer a bounded value leaves behind. `size` is the whole value's length, so
// the reader sees how much the preview left out. The field is named `tmp` because it is the
// recorded event's own shape, which replay and every consumer read by that name.
export const spillPointer = (ref: string, size: number, preview: string, note: (ref: string) => string = WORKSPACE_SPILL_NOTE) => ({
  tmp: ref,
  size,
  preview,
  note: note(ref)
})
