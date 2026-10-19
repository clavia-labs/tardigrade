# Grove

Grove materialises versioned JSON state from immutable logs, using ordinary reducers, incremental SQLite updates and reclamation of unretained state.

```text
immutable log -> reducer(state, event) -> JSON state
                                             |
                                  reconcile changed paths
                                             |
                                     grove_state_* rows
                                             |
                         retain referenced versions / reclaim the rest
```

```sh
bun add @tardie/grove effect
```

## Ordinary reducers

```ts
import { Schema } from "effect"
import { makeSync } from "@tardie/grove/reducer"

const grove = makeSync(driver, { scope: "agent" })
const messages = grove.materialize({
  name: "messages",
  schema: Schema.Struct({ messages: Schema.Array(Schema.String) }),
  input: Schema.String,
  initial: { messages: [] },
  reduce: (state, text) => ({ messages: [...state.messages, text] }),
})

const head = messages.head()
const next = messages.apply(head ?? messages.initial(), {
  sequence: 42, event: "Hello", metadata: null,
})

grove.transaction(tx => {
  tx.execute("INSERT INTO events(seq, event) VALUES (?, ?)", [42, JSON.stringify("Hello")])
  messages.publish(tx, next, { expected: head?.reference ?? null })
})
grove.discard()
```

The application creates its event table. `driver` provides a stable connection `identity`, synchronous `execute(sql, parameters)` returning rows, and `transaction(work)` committing or rolling back the callback. The event and materialisation use the same connection and transaction.

```ts
next.value.messages // ["Hello"] when starting empty
next.sequence       // 42
next.reference      // opaque snapshot identifier
```

`apply` validates the event and state. Sequence numbers advance, with gaps allowed. Shared subtree identity skips reconciliation; fresh arrays require a linear scan. Small array-free objects can occupy a packed row. Current state is eager JSON; cold opens reconstruct complete snapshots. No content hashing is performed by the reducer backend.

## Retain what durable work needs

```ts
grove.transaction(tx => grove.retain(tx, "effect/7", next.reference))
const input = messages.open(next.reference).value

// Commit effect completion together with release.
grove.transaction(tx => {
  tx.execute("DELETE FROM pending_effects WHERE id = ?", ["7"])
  grove.release(tx, "effect/7", { expected: next.reference })
})
grove.collect()
```

Create the pending-work record in the transaction that retains its input. Published heads, retained owners and staged dependencies protect versions. Copying a reference does not retain it. Collection can expire unretained references; already materialised JSON follows ordinary JavaScript lifetimes.

```text
grove_state_
  current / history / chunks      state payloads
  documents / versions / heads    revisions and publication
  owners / gc_pins                retention and collection
```

`DEFAULT_PACK_BYTES` is 4096; `packBytes: 0` disables packing. `DEFAULT_CHUNK_BYTES` is 64 KiB; `chunkBytes` must be at least `MIN_CHUNK_BYTES` (5). Both options are accepted by `makeSync`. Changing the packing budget starts a new document on publication while retained versions remain readable.

`stats()` reports cumulative attempted reconciliation, encoding and internal SQL work, including rollbacks. `stagedVersions` reports current staging. Application statements submitted through `tx.execute` are outside the internal SQL counter. [Reducer properties](test/reducer/) compare independent plain folds, retention lifecycles, rollback and work budgets across growing collections.

## Tardigrade

```ts
durableAtom({
  name: "messages",
  schema: State,
  input: Event,
  initial,
  reduce: (state, event) => nextState(state, event),
})
```

```text
application    ordinary schemas and reducers
Tardigrade     event log / effects / checkpoints
Grove          reconciliation / materialisation / retention
```

SQLite-backed untagged atoms use the reducer backend. Existing inline checkpoints and schema-authored collection references restore through their readers; subsequent checkpoints publish reducer references. Accepted work keeps its original references until release. Event-log rows retain their format. Memory-only sessions checkpoint inline JSON.

## Schema-authored collections

The root package and `@tardie/grove/sqlite` also expose explicit tree, append-only and key-value authoring. Their reference reader remains available for existing materialisations. In that store, `reducerChunkBytes` configures reducer payload chunks independently of legacy `chunkBytes`; its default is the 64 KiB `DEFAULT_CHUNK_BYTES` exported by `@tardie/grove/reducer`.

## Start with JSON

```ts
const initial = {
  document: { title: "Untitled" },
  messages: [],
  jobs: {},
}
```

## Give each collection an edit vocabulary

```ts
import { Schema } from "effect"
import * as Grove from "@tardie/grove"

const Message = Schema.Struct({ text: Schema.String })
const Job = Schema.Struct({ status: Schema.String })
const State = Schema.Struct({
  document: Grove.tree(Schema.Struct({ title: Schema.String })),
  messages: Grove.appendOnly(Schema.Array(Message)),
  jobs: Grove.keyValue(Job),
})
```

```text
tree        set paths / remove fields / splice arrays
appendOnly  append entries / replace the collection
keyValue    set or remove whole entries by key
```

## Connect synchronous storage

```ts
import { Database } from "bun:sqlite"
import { makeSync, type SyncSqlite } from "@tardie/grove/sqlite"

const db = new Database(":memory:")
const driver: SyncSqlite = {
  identity: db,
  execute: (sql, parameters) =>
    db.query<Record<string, unknown>, (typeof parameters)[number][]>(sql)
      .all(...parameters),
  transaction: work => db.transaction(work)(),
}
const options = {
  scope: "workspace",
  cacheBytes: Grove.DEFAULT_READ_CACHE_BYTES,
}
const store = makeSync(driver, options)
const documents = store.bind(State)
```

Use a file-backed database for durability. A Durable Object supplies the same driver through `storage.sql.exec` and `storage.transactionSync`.

## Edits produce versions

```ts
const a = documents.initial(initial)
const b = a.set(["document", "title"], "Research")
const c = b.append(["messages"], [{ text: "Hello" }])
const d = c.set(["jobs", "summarize"], { status: "pending" })
const e = d.remove(["jobs", "summarize"])

a.read(["document", "title"])  // "Untitled"
b.read(["document", "title"])  // "Research"
a.length(["messages"])         // 0
c.length(["messages"])         // 1
d.has(["jobs", "summarize"])  // true
e.has(["jobs", "summarize"])  // false
```

```text
version a -> document A + messages A + jobs A
version b -> document B + messages A + jobs A
version c -> document B + messages C + jobs A
version d -> document B + messages C + jobs D
```

Batch related edits into a version:

```ts
const completed = d.batch(edit => {
  edit.append(["messages"], [{ text: "Summary ready" }])
  edit.remove(["jobs", "summarize"])
})
```

Paths and values follow the schema. Append-only entries cannot be edited in place; key-value entries are replaced as a whole.

## Read what you need

```ts
d.read(["document", "title"])
d.read(["jobs", "summarize"])
d.length(["messages"])
d.slice(["messages"], 0, 10)
d.read([])
```

`read([])` materializes the entire document. Selections describe a version and a subset without loading its values:

```ts
const selected = d.selectEach(["messages"], ["text"], { start: 0, end: 1 })
const reference = store.reference(selected)
const encoded = Grove.encodeReference(reference)
```

References belong to a storage scope. Persist them with `encodeReference`; restore them with `decodeReference`.

## Publish atomically

```ts
db.exec("CREATE TABLE app_events(seq INTEGER PRIMARY KEY, event TEXT NOT NULL)")

store.transaction(tx => {
  store.commit(tx, {
    publish: [{ owner: "head", expected: null, document: d }],
  })
  tx.execute("INSERT INTO app_events VALUES(?,?)", [
    0, JSON.stringify({ type: "Received", text: "Hello" }),
  ])
})
store.discard()

const view = store.view(reference, Schema.Array(Schema.String))
view.read([0])      // "Hello"
view.materialize()  // ["Hello"]
```

```text
one SQLite transaction
  + application event
  + changed tree nodes / appended rows / keyed revisions
  + head ownership
```

`expected` checks the owner's previous reference. A failed transaction preserves its published version; staged edits remain available for retry. `discard()` drops staged edits after publication or abandonment.

## Reopen a version

```ts
const reopened = makeSync(driver, options)
const head = reopened.owner("head")!
const restored = reopened.bind(State).open(head)
const selectedAgain = reopened.view(
  Grove.decodeReference(encoded),
  Schema.Array(Schema.String),
)

restored.read(["document", "title"])  // "Research"
selectedAgain.read([0])               // "Hello"
```

## Retain what future reads need

```ts
reopened.transaction(tx => reopened.commit(tx, {
  retain: [{ owner: "input/1", selection: Grove.decodeReference(encoded) }],
}))

const next = restored.append(["messages"], [{ text: "Another message" }])
reopened.transaction(tx => reopened.commit(tx, {
  publish: [{ owner: "head", expected: head, document: next }],
}))
reopened.discard()
reopened.collect()

selectedAgain.materialize()  // ["Hello"]
```

Release an obsolete owner, then collect:

```ts
reopened.transaction(tx => reopened.commit(tx, {
  release: [{ owner: "input/1", expected: Grove.decodeReference(encoded) }],
}))
reopened.collect()
```

```text
head --------> current version
input/1 -----> selected version
                    |
               shared storage

release input/1 -> collect unreachable material
```

## Size the read cache

```ts
const tuned = makeSync(driver, {
  scope: "workspace",
  cacheBytes: 4 * 1024 * 1024,
})

tuned.stats()
```

The cache budget counts encoded bytes for nodes, log rows and keyed entries. Decoded objects, application views and staged edits use additional memory. `cacheBytes: 0` disables the committed read cache. Tree layout and SQLite chunking defaults are exported from `@tardie/grove` and `@tardie/grove/sqlite`.
