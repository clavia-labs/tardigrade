# Durable atom families

`tardie/experimental` exports `durableAtom.family` and its standalone spelling, `durableAtomFamily`. Each string key identifies an ordinary durable atom with its own validated state and checkpoint name. Members are created on access and memoized with Effect's weak-reference atom family cache.

```ts
import { Schema } from "effect"
import { durableAtom } from "tardie/experimental"

const Added = Schema.Struct({ type: Schema.Literal("Added"), id: Schema.String, amount: Schema.Int })
const balance = durableAtom.family({
  name: "account.balance",
  input: Added,
  key: event => event.id,
  schema: Schema.Int,
  initial: 0,
  reduce: (state, event) => state + event.amount,
})

const account = balance("solver-b")
```

Read a member with `get(balance(id))` inside a derived atom or with `store.get(balance(id))`. The reducer receives the matching event's metadata and absolute zero-based journal position. A key function returning `undefined` skips that event. Composite keys can use `JSON.stringify([parent, name])`. Member checkpoint names encode `[familyName, indexVersion, key]` as JSON; use `balance(id).name` when supplying initial state. These name tuples are reserved for family members. Family names must be unique within an event log.

`DEFAULT_DURABLE_ATOM_FAMILY_IDLE_TTL` is zero milliseconds. Set `idleTTL` on the family to retain unused members longer, or use `Infinity` to retain their values for the store lifetime. Subscribers and dependent atoms pin members while they are in use. Both the value and its reducer cursor use this policy. Reading an evicted member reconstructs it from its checkpoint or journal history. Runtime frames omit finite-retention member values, so a discarded registry or a snapshot branch reconstructs those members on access.

SQL-backed actor runtimes register a family on first read. The journal backfills its key index in pages, with each page's rows and progress cursor committed together. A later open resumes that cursor. After registration, appends write the journal records, their family keys, and the index cursor in the same transaction. Each family has a separate index, so an event can belong to several families. Unaccessed families catch up when first read.

Member reads fetch matching indexed events in journal order within the snapshot's bounds. Events being prepared by the runtime are folded separately and acquire index rows when committed. Index routing uses the actor's historical event decoder and the same observation and message-unwrapping rules as ordinary durable atom reducers. The journal remains authoritative; indexes can be rebuilt from its records.

`indexVersion` defaults to `DEFAULT_DURABLE_ATOM_FAMILY_INDEX_VERSION`, which is `"1"`. Change it when key routing, input matching, or historical event decoding changes which members an event belongs to. The next read rebuilds the family's index and uses fresh member checkpoint names. Changes to reducer semantics can also use a new version to force member reconstruction. The index is registered per journal connection; writes from another connection are indexed when the reader catches up.

`DEFAULT_FAMILY_INDEX_BATCH_SIZE` is 16 records. Set `familyIndexBatchSize` on `sqlJournal`, `bunJournal`, `cloudflareJournal`, `createBunHost`, or `createActorObjects` to change backfill and indexed-read page sizes. The constant is exported from `tardie/platform/journal`, `tardie/platform/bun`, and `tardie/platform/cloudflare`. Page size affects database reads and temporary memory, and does not truncate the events a member sees.

Members use the existing checkpoint format. Resident members are captured by the runtime's ordinary checkpoint mechanism. A member absent from a checkpoint requires historical journal access, including any `StateInitialised` record. SQL-backed actor runtimes supply this access automatically. Registered families can omit evicted members and obsolete index versions from subsequent checkpoints because those members are reconstructible. Ordinary atom completeness checks still apply, and resident member states share one checkpoint payload.

`get(balance.keys({ after, limit }))` lists indexed keys in Unicode scalar order without loading their member values. `after` is exclusive, `limit` defaults to `DEFAULT_DURABLE_ATOM_FAMILY_PAGE_SIZE` (100), and the result contains `keys` and an optional `next` cursor. Keys represented only by initial state and carrying no indexed events are absent. SQL-backed readers fetch bounded key pages, and runtimes merge any keys introduced by prepared events within the snapshot. Other sources scan their replay ranges while retaining a bounded key page.

Custom journals can implement the optional `Journal.readFamily` and `Journal.readFamilyKeys` surfaces for persistent indexed reads. Runtimes with journals lacking these methods, standalone in-memory event logs, and raw EventLog sources fall back to scanning and filtering their replay ranges. The native supervisor uses families for thread allocations and name claims. Changed-member checkpoint storage, trajectory conversion, and directory migration are outside this implementation.

The main supervisor consumes families internally while its store API uses supervisor-owned selection and pagination types. Its compatibility contract is the supervisor event journal. Family tables and tagged checkpoints are rebuildable projections; a future supervisor implementation can choose another checkpoint tag and replay the same journal without preserving family objects or their checkpoint names.
