# Grove

Grove is a versioned JSON document store backed by SQLite. Objects use keyed B+ tree pages; arrays use balanced sequence pages with subtree counts. Memory and disk references share the same editing algorithms. An edit copies affected pages and shares unchanged pages with earlier roots.

```text
pure reducer -> reconcile --+
                           +-> shared pages -> working root
explicit edits ------------+                      |
                                    checkpoint or retained input
                                                  |
                                     SQLite pages + root reference
```

## Ordinary reducers

```ts
import { Schema } from "effect"
import { makeSync } from "@tardie/grove/sqlite"

const grove = makeSync(driver, { scope: "agent" })
const messages = grove.materialize({
  schema: Schema.Struct({ messages: Schema.Array(Schema.String) }),
  reduce: (state, text: string) => ({ messages: [...state.messages, text] }),
})
const initial = messages.initial({ messages: [] })
const next = initial.apply("Hello", null, 1)

grove.transaction(tx => {
  tx.execute("INSERT INTO events(seq,event) VALUES(?,?)", [1, JSON.stringify("Hello")])
  grove.commit(tx, { publish: [{ owner: "head", expected: null, document: next.reference }] })
})
```

The application creates its event table. `driver` supplies a stable connection `identity`, synchronous `execute(sql, parameters)` returning rows and `transaction(work)`. Journal writes and root publication share that transaction. A failed transaction restores tentative page identities and owners; transaction handles expire when their callback returns.

Pure reducers receive immutable ordinary JSON. Reconciliation reuses shared immutable subtrees. Fresh arrays require inspection; full reads and fresh replacements can require linear work. Object pages navigate keys by UTF-16 comparison and retain field ordinals to preserve JavaScript property order when materialising JSON. Whole-object reads sort fields by ordinal; indexed path reads use the keyed tree.

## Explicit edits

```ts
const State = Schema.Struct({ messages: Schema.Array(Schema.String) })
const before = grove.bind(State).initial({ messages: [] })
const after = before.append(["messages"], ["Hello"])
const changed = after.set(["messages", 0], "Welcome")
changed.read(["messages", 0])
changed.slice(["messages"], 0, 16)
```

Documents support `set`, `remove`, `append`, `splice` and `batch`. A batch applies edits sequentially and publishes its result after the callback succeeds. `remove` deletes optional object properties; `splice` edits arrays. `tree`, `appendOnly` and `keyValue` schema declarations preserve their edit restrictions. Schema checks validate changed values; constraints spanning a container require whole-value replacement.

## Tardigrade atoms

```ts
durableAtom({
  name: "messages", schema: State, input: Added, initial,
  reduce: (state, event) => ({ messages: [...state.messages, event.text] }),
})

durableAtom({
  name: "messages", schema: State, input: Added, initial,
  edit: (state, event) => {
    state.append(["messages"], [event.text])
  },
})
```

A durable atom accepts either `reduce` or `edit`. An edit callback receives typed reads and mutations and expires after returning. Ordinary reducers expose JSON state; explicit atoms expose selective document reads. Both use Grove's shared page engine. Core keeps ordinary transitions virtual, commits their events and publishes roots at its configured checkpoint cadence. Pending work persists and retains its selected input immediately. A dirty allocation budget can spill working pages without advancing the recovery checkpoint. Recovery loads the checkpoint and replays the journal suffix.

Memory sessions use the same tree and preserve inline checkpoints for ordinary reducers. SQLite checkpoints keep the `DocumentState` envelope and encode opaque scoped references. Event records retain their domain format.

## Retention and collection

```ts
const input = after.select(["messages"])
grove.transaction(tx => grove.commit(tx, {
  retain: [{ owner: "effect/7", selection: input }],
}))

const reference = grove.owner("effect/7")!
grove.view(reference, Schema.Array(Schema.String)).materialize()
grove.transaction(tx => grove.commit(tx, {
  release: [{ owner: "effect/7", expected: reference }],
}))
grove.collect()
```

Retain the input in the transaction that accepts its work. Release it in the transaction that settles the work. Published roots, pending inputs, active read leases and locally held projections protect their pages. Collection reclaims unreferenced versions and pages. A reference string alone does not retain data. Full materialisation costs proportional to the returned JSON.

## Storage boundary

```text
grove_pages / grove_page_chunks     immutable encoded pages and large text
grove_page_versions                 logical version -> root
grove_page_owners                   publication and retention
grove_page_settings                 stored tree capacity
```

The page codec chunks large records, verifies their byte lengths and checksums on load and uses ordinary SQLite page identifiers. Checksums authenticate stored payloads; page identity does not require content hashing.

| Policy | Exported default | Value |
| --- | --- | --- |
| Page capacity | `DEFAULT_CAPACITY` | 32 |
| Inline text bytes | `DEFAULT_INLINE_BYTES` | 64 |
| Encoded cache bytes | `DEFAULT_CACHE_BYTES` | 1,048,576 |
| Dirty allocation bytes | `DEFAULT_DIRTY_BYTES` | 1,048,576 |
| SQLite chunk bytes | `DEFAULT_CHUNK_BYTES` | 131,072 |

These defaults are exported by `@tardie/grove/sqlite`; `makeSync` accepts `capacity`, `inlineBytes`, `cacheBytes`, `dirtyBytes` and `chunkBytes` overrides. A stored scope fixes page capacity. Cache accounting measures encoded bytes. Dirty accounting measures estimated cumulative allocations, including superseded pages; it is not a bound on JavaScript heap. Diagnostics expose configured policies, reads, writes, allocations, cache occupancy and budget spills. Counters include attempted work from failed transactions.

## Checkpoint compatibility

Existing tree and reducer references use their storage readers. Opening an old atom state builds a working page root; publication writes the new representation. Pending inputs keep their original references and storage until released. An upgrade does not rewrite the event log or require a bulk database conversion. Old tables can coexist with page tables while old roots remain retained.

`@tardie/grove/reducer` and `make(storage)` support the row codec and encoded-node staging integrations. The default Tardigrade memory and SQLite sessions use the shared page engine. [Page properties](test/pages.ts) run on Bun and Cloudflare SQLite; [migration properties](test/reducer/integration.ts) exercise old checkpoint inputs, rollback and reclamation. [Tree properties](test/page-tree.test.ts) check balancing, retained roots and path work bounds against independent arrays and maps.
