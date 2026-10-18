<p align="left">
  <a href="https://www.npmjs.com/package/@tardie/grove"><img alt="npm version" src="https://img.shields.io/npm/v/@tardie/grove.svg"></a>
</p>

> [!WARNING]
> Grove is under active development. APIs may change.

# Grove

Grove is a TypeScript library for working with immutable JSON documents backed by synchronous SQLite storage. It provides schema-bound edits, structural sharing and selective reads, so applications can keep large documents in storage and materialize the parts they need.

```text
document + edit -> new document
                       |
                    reference -> view -> requested JSON
```

## Quickstart

```sh
bun add @tardie/grove effect@4.0.0-rc.115
```

The examples use a configured `grove` store. See [SQLite storage](#sqlite-storage) for setup with Bun or Cloudflare Durable Objects.

### Documents hold state

Bind a schema and create a document.

```ts
import { Schema } from "effect"

const Message = Schema.Struct({
  role: Schema.String,
  text: Schema.String,
})
const State = Schema.Struct({
  status: Schema.String,
  messages: Schema.Array(Message),
})

const documents = grove.bind(State)
const before = documents.initial({ status: "idle", messages: [] })
```

Grove uses Effect schemas for validation. Reads and edits are synchronous functions and need no caller-supplied Effect runtime.

### Edits create versions

Use paths to update fields and collections.

```ts
const after = before.batch(edit => {
  edit.append(["messages"], [{ role: "user", text: "Hello" }])
  edit.set(["status"], "ready")
})

after.read(["status"]) // "ready"
before.read(["status"]) // "idle"
```

`before` remains unchanged. `after` shares unchanged storage with it. Paths and incoming values are checked against the schema.

The edit vocabulary is `set`, `append`, `splice` and `remove`. `batch` applies several edits as one new version. Use `splice` to insert or delete array entries, and `remove` for optional object fields or keyed entries. Tree schemas support plain JSON structs, string-keyed records and homogeneous arrays. Encodings and constructor defaults require the legacy value reducer. Nested containers with cross-field checks require whole-value edits; unsupported roots fail at binding.

### Collection shapes

Declare the edit vocabulary at collection boundaries. Values inside a collection use ordinary JSON schemas.

```ts
import { tree, appendOnly, keyValue } from "@tardie/grove"

const State = Schema.Struct({
  document: tree(Document),
  messages: appendOnly(Schema.Array(Message)),
  jobs: keyValue(Job),
})
```

| Shape | Edits | Storage |
|---|---|---|
| `tree(schema)` | Set paths, remove optional fields, splice arrays | Structurally shared nodes |
| `appendOnly(arraySchema)` | Append entries | Immutable rows and prefix manifests |
| `keyValue(valueSchema)` | Set or remove a whole entry by string key | SQLite rows keyed by branch, key and revision |

Each shape supports whole-collection replacement. Key-value entries do not permit nested edits; reads may select fields inside an entry. Key-value snapshots use a small version node and branch revision boundaries. Linear updates append whole values or deletion markers to a SQL branch; edits from earlier snapshots fork. Key lookup uses the latest revision visible at those boundaries. Owners, active reads and held drafts retain snapshots. Collection removes superseded revisions and obsolete deletion markers while preserving rows visible to retained snapshots. Empty collections release their branch dependencies.

Key-value payloads have no Merkle key index or per-value node hash. SQLite durability, immutable revision writes, chunk ordering, encoded lengths and consumer schemas protect the read path. Equal-length payload alterations are not authenticated by a per-row hash. Metadata, decoded values and row manifests share `cacheBytes`; `rowBatchItems` bounds key enumeration batches. Standalone `make` uses in-memory revisions unless supplied a synchronous `maps` backend; persistence adapters write prepared map revisions before acknowledging a batch.

Core's `durableAtom` recognizes a tagged root or a struct whose fields each declare a collection. Reducers receive Grove documents with typed reads, edits and selections. Partially declared structs fail at construction. Union and suspended roots containing collection declarations require an explicit outer `tree(...)` declaration. An untagged schema selects the legacy plain reducer and emits a construction-time deprecation warning. Low-level Grove bindings also accept ordinary JSON schemas as trees.

### Append-only collections

Mark a collection whose existing entries stay unchanged.

```ts
import { appendOnly } from "@tardie/grove"

const History = Schema.Struct({
  entries: appendOnly(Schema.Array(Message)),
})
```

The array accepts `append` and whole-value `set`; indexed edits, edits inside existing entries and `splice` fail at compile time and runtime. Replacing a parent or the whole array creates a new version, which supports compaction. Ordinary JSON arrays remain valid initial and replacement values.

Grove stores marked entries as immutable SQLite rows. A small version node identifies the collection's prefix; divergent versions share existing prefixes and add a suffix stream. Cold appends write new rows and version metadata without loading historical entry payloads. Bounded range scans, scoped references, retention and collection use the same transaction and cache budget as trees.

### References capture a value

Select the part of a document another consumer needs.

```ts
import { encodeReference, decodeReference } from "@tardie/grove"

const selected = after.select(["messages"])
const reference = grove.reference(selected)
const encoded = encodeReference(reference)
```

A reference identifies that selection from that exact document version. Creating or encoding it does not construct the messages array. Later edits preserve the selection's meaning.

### Owners keep versions alive

Commit the document and retain the selection in one transaction.

```ts
grove.transaction(tx => {
  grove.commit(tx, {
    publish: [{
      owner: "chat",
      expected: null,
      document: after,
    }],
    retain: [{ owner: "request/42", selection: selected }],
  })
})
```

`publish` sets the current document for a named owner. `expected: null` requires that owner to be absent; subsequent publication supplies its previous reference. `retain` keeps a value available for another consumer.

Document dependencies and ownership commit together. Application records can join the same transaction through `tx.execute(statement, parameters)`. A failed transaction rolls back its writes and leaves the draft available for retry.

### Views read the working set

Open a view from the committed reference.

```ts
const view = grove.view(decodeReference(encoded), Schema.Array(Message))

view.length([])          // 1
view.read([0, "text"])  // "Hello"

for (const message of view.scan([])) {
  console.log(message.text)
}

const messages = view.materialize()
```

`read` materializes the requested subtree. `scan` reads array items as they are consumed. `materialize` constructs the whole selected value as ordinary JSON.

```text
SQLite -> document handle -> select -> reference
                                         |
                                         v
                                        view
                                         |
                           read / scan / materialize
                                         |
                                         v
                                  ordinary JS values
```

Reading a whole array still allocates that array. References and views let the consumer choose when that happens.

### Release what you finish using

Release a request's owner when its work completes.

```ts
grove.transaction(tx => {
  grove.commit(tx, {
    release: [{ owner: "request/42", expected: reference }],
  })
})

grove.collect()
```

Collection reclaims stored nodes unreachable from durable owners, explicit local holders and active read leases. The `chat` owner still protects its current version. A JS reference alone does not retain stored data.

Local holders protect draft dependencies until released. Active scans hold a read lease until completion or explicit iterator closure. Discard abandons unheld staged changes.

## SQLite storage

`@tardie/grove/sqlite` integrates documents, ownership and application SQL through one native synchronous connection. A stable scope identifies the store when reopening references.

### Bun

```ts
import { Database } from "bun:sqlite"
import { makeSync } from "@tardie/grove/sqlite"

const db = new Database(":memory:")
const grove = makeSync({
  identity: db,
  execute: (statement, parameters) =>
    db.query<Record<string, unknown>, (typeof parameters)[number][]>(statement)
      .all(...parameters),
  transaction: work => db.transaction(work)(),
}, { scope: "chat", cacheBytes: 0 })
```

Use a file path in place of `:memory:` to retain the store across process restarts. The caller owns the connection and closes it with `db.close()` after finishing with the store.

### Cloudflare Durable Objects

```ts
import { makeSync } from "@tardie/grove/sqlite"

const grove = makeSync({
  identity: storage.sql,
  execute: (statement, parameters) =>
    storage.sql.exec(statement, ...parameters).toArray(),
  transaction: work => storage.transactionSync(work),
}, { scope: storageIdentity, cacheBytes: 0 })
```

Here `storage` is the object's storage and `storageIdentity` is a stable scope, such as its Durable Object ID. Handles sharing a native connection use the same `identity` object.

## Memory

Committed document contents can remain in SQLite. Hot memory contains active handles, staged edits, traversal state, requested values and configured caches.

The decoded-read cache defaults to 32 MiB of encoded bytes shared by tree nodes, log manifests and row pages. `cacheBytes` overrides that budget; the examples disable it with zero. This accounts for encoded size and does not bound decoded heap or process RSS. `rowBatchItems` overrides `DEFAULT_ROW_BATCH_ITEMS` (64) for bounded row reads, and statistics expose its effective value. `grove.stats()` reports cache activity, loaded rows, staging, holders and read leases.

Tree layout uses the exported `DEFAULT_PAGE_ITEMS`, `DEFAULT_FANOUT`, `DEFAULT_LEAF_BYTES`, `DEFAULT_TAIL_BYTES` and `DEFAULT_OBJECT_PAGE_ITEMS`; the corresponding camel-case options override them.

## Contributing

```sh
bun run --cwd packages/grove test
bun run --cwd packages/grove test:workers
bun run --cwd packages/grove typecheck
```

The suite uses property tests to compare generated edits and transaction schedules against plain JSON models, including rollback, collection and reopening in Bun and workerd.

See the repository [contributing guide](../../CONTRIBUTING.md).
