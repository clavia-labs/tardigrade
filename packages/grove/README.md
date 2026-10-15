# Grove

Immutable JSON trees with structural sharing, selective reads and incremental persistence.

Grove stores JSON as Merkle snapshots. Updates share unchanged nodes; `MerkleTree<State>` provides typed edits and selective reads.

```text
 snapshot A                                        snapshot B
      │                                                 │
      ├───────────────► shared subtree ◄────────────────┤
      │                        │                        │
      │                   ┌────┴────┐                   │
      ▼                   ▼         ▼                   ▼
  old data             data 1    data 2           updated data
```

Use Grove for growing histories, versioned documents and durable state. Applications define schemas and retain the roots they need.

## Quickstart

```sh
bun add @tardie/grove effect
```

Create Grove with a synchronous node loader. This example stores encoded nodes in memory.

```ts
import { Schema } from "effect"
import * as Grove from "@tardie/grove"

const storage = new Map<string, string>()
const load = (hash: string) => {
  const text = storage.get(hash)
  if (text === undefined) throw new Error(`Missing node: ${hash}`)
  return text
}

const State = Schema.Struct({
  status: Schema.String,
  messages: Schema.Array(Schema.Struct({
    role: Schema.String,
    text: Schema.String,
  })),
})

const grove = Grove.make({ load })
const snapshots = grove.bind(State)
const original = snapshots.initial({ status: "idle", messages: [] })

const next = original
  .append(["messages"], [{ role: "user", text: "Hello" }])
  .set(["status"], "ready")

console.log(original.length(["messages"]))
console.log(next.read(["messages", 0, "text"]))
```

The outputs are `0` and `"Hello"`. Updates return new snapshots; the schema types paths and values and validates reads and edits.

## Read the working set

Choose what to load.

```ts
next.read(["status"])
next.length(["messages"])
next.slice(["messages"], 0, 10)
next.read(["messages"])
```

`read` and `slice` materialize selected data. `length` uses size metadata where available. A full conversation read loads the full conversation.

Selections capture a snapshot without loading its values.

```ts
const selected = next.select(["messages"])
const reference = Grove.selectionReference(selected)!
const messages = grove.readReference(reference)
```

`selectionReference` converts an opaque selection into a serializable descriptor. `selectEach` adds a per-item projection. Retain the referenced root while needed.

## Persist a snapshot

Write staged nodes and publish the root before acknowledging the batch.

```ts
const staged = grove.nodes()
for (const [hash, node] of staged) storage.set(hash, node.text)
const root = next.root
grove.committed(staged)

const reopened = Grove.make({ load }).bind(State).open(root)
console.log(reopened.read(["status"]))
```

The output is `"ready"`. Durable stores must save the root too. Publish nodes and root atomically when readers or collection can observe changes; acknowledge successful writes with `committed`, which preserves newer edits.

The SQLite adapter provides named roots, transactional publication, stale-write checks and collection. Release ownership when finished; collection removes unreachable nodes.

## Tune the working set

Configure caching and tree layout.

```ts
const cached = Grove.make({
  load,
  options: { cacheBytes: 16 * 1024 * 1024 },
})
```

The default cache budget is 256 KiB of encoded node bytes; decoded values use additional memory. Size it for the working set to avoid repeated loads. `grove.stats()` reports loads, hits, evictions and cached bytes.

Layout options are `leafBytes`, `tailBytes`, `pageItems` and `fanout`. SQLite adds `chunkBytes` and `maxParameters`. Defaults are exported from their respective modules.
