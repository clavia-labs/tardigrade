# Grove

Schema-bound, immutable JSON with synchronous reads and SQLite persistence.

```sh
bun add @tardie/grove effect
```

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
