# Synchronous stored-value journal

`synchronousJournal` connects Tardigrade's durable document atoms and captured effect inputs to Grove's stored-value API. It is available through the platform journal, Bun and Cloudflare entry points. Construction takes an explicit `SyncSqlite` driver with a native synchronous transaction. Journal events, checkpoints, effect input acceptance, document publication and owner changes share that transaction.

`bunJournal`, `cloudflareJournal`, `createBunHost` and the Cloudflare object hosts use this storage boundary by default. Bun owns its native `Database` connection and closes it after journal shutdown. Cloudflare borrows Durable Object storage and uses `storage.transactionSync`. Application code keeps its existing atom, method and effect authoring APIs.

```ts
import { synchronousJournal } from "@clavia/tardigrade-platform/bun"

const journal = synchronousJournal<Event>({
  actor: "conversation",
  driver: {
    identity: db,
    execute: (statement, parameters) => db.query(statement).all(...parameters),
    transaction: work => db.transaction(work)(),
  },
  cacheBytes: 0,
})

const actor = await Effect.runPromise(createActorStore({
  actor: definition,
  journal,
  services,
  actorContext,
}))
```

The example assumes a Bun SQLite connection and application-supplied definition, services and actorContext. A Durable Object uses `storage.sql` as identity, `storage.sql.exec(statement, ...parameters).toArray()` for execution and `storage.transactionSync(work)` for its transaction. The journal borrows the connection; its caller owns connection closure. The actor store closes before the journal. One active actor runtime owns the journal's projection/proposal holders for a given actor identity. Concurrent publication is rejected by expected journal position and Grove head checks; this slice does not coordinate holders across concurrently active runtimes with the same actor identity.

Document authoring uses `durableAtom` with collection-tagged schemas, typed reads, edits and `requestTree` calls. The journal exposes `storedValues` to the runtime. That session represents checkpoint and input sources with Grove's encoded opaque references. Source selection paths and ranges remain inside the Grove codec. Effect input selections contain an opaque `reference` and the destination `target` in the input JSON. Grove owns source paths, projections and ranges inside its reference codec. Durable state envelopes use `reference` for their encoded document identity; application code does not parse it. Plain JSON is materialized and checked when an accepted effect executes.

Core submits document identities and accepted input changes through the journal contract. It declares local holds and releases directly through the stored-value session; Grove tracks those requirements. The journal reconciles Grove's current local holds into durable owners inside the commit transaction, including holds acquired during asynchronous payload preparation. It does not submit node batches or acknowledge staged nodes. Checkpoints use a byte envelope containing those identities; the journal exposes `readCheckpoint` and `appendWithCheckpoint` independently of document layout. Grove flushes the referenced dependencies and acknowledges staged writes after the native transaction succeeds. Every journal provides a synchronous document session backed by the same native transaction as its records.

The default storage scope is `JSON.stringify(["tardigrade", actor])`. `scope` overrides it and must remain stable across reopening. Grove's configurable read, layout, chunk and SQL batching options pass through to its synchronous store. A selection alone creates no durable ownership. The journal retains current heads, checkpoint references, live projection/proposal references and accepted inputs under separate application owner names. Completion releases accepted input owners according to Core's existing execution and cancellation lifecycle policy.

After publication, holder retention and application writes commit successfully, the journal abandons remaining unreferenced drafts in its authoring session. Drafts intended to survive a commit must belong to a published document or a live holder/input. Commit retention includes holders acquired while asynchronous payload preparation was in progress. The journal exclusively owns this authoring session; its exposed `grove` handle supports diagnostics and explicit reference access, and must not be used to maintain unrelated unregistered drafts. `journal.collect` reconciles current local holders and asks Grove to collect unreachable storage. `collectEvery` enables collection after a configurable number of checkpoints; omission leaves collection explicit. Its counter persists in `stored_journal_collections` and changes atomically with the checkpoint. `journal.collection.everyCheckpoints` exposes the effective policy. `journal.close` reconciles remaining holder ownership and rejects subsequent reads and writes. Direct `synchronousJournal` callers retain native connection ownership. The journal owns the outer transaction for append; invoking append inside another Grove transaction fails before publication state changes.

## Persistence boundary

The journal stores headers in `stored_journal_events`, `stored_journal_inputs` and `stored_journal_checkpoints`. Their payload tables are `stored_journal_event_chunks`, `stored_journal_input_chunks` and `stored_journal_checkpoint_chunks`. Headers record UTF-8 byte length, chunk count and SHA-256 digest. Readers require consecutive chunk ordinals, exact counts and lengths, and matching digests before decoding. Event headers keep the event type available for SQL queries. Grove owns its node, chunk, owner and collection tables. Head publication checks the references observed by the journal instance. A failed transaction preserves staged documents for retry and leaves publication expectations unchanged. Payload chunks, headers and Grove ownership commit together. Replacing a checkpoint or completing an input removes its obsolete chunks in the same transaction.

`eventInlineBytes` defaults to the exported `DEFAULT_EVENT_INLINE_BYTES` of 1,500,000 bytes. Larger records use chunks. Inputs and byte checkpoints use chunks regardless of size. `checkpointChunkBytes` controls these payload chunks and defaults to the exported `DEFAULT_CHECKPOINT_CHUNK_BYTES` of 512 KiB. Grove's separate `chunkBytes` option controls its stored document payloads.

Supply `limits: { maxRowBytes }` for a driver with a row size limit. Cloudflare callers can pass the exported `CLOUDFLARE_SQL_LIMITS`. Default payload sizes shrink to fit the remaining row capacity after actor identity, metadata and record overhead; explicit overrides exceeding that capacity reject construction. Input chunk capacity also accounts for the encoded effect identity. `journal.chunking` exposes the effective `checkpointChunkBytes`, `eventInlineBytes`, `maxRowBytes` and `inputChunkBytes(effectKey(ref))`. These policies change storage layout without truncating application data.

Opening a journal created by the initial inline stored-value adapter adds nullable payload metadata columns and chunk tables. Its existing inline rows remain readable; subsequent writes use the digest-checked envelopes. Existing accepted inputs remain immutable across this upgrade.

The stored-value path rejects an existing legacy journal for the same actor before creating its journal tables. The legacy adapter rejects a stored-value journal for that actor before creating its event tables. This is a format rejection boundary, not a migration. Existing format conversion requires a separate tested migration.

Checkpoint envelopes contain stored document references. Legacy event journals, byte checkpoints at position zero, legacy tree checkpoints and accepted input tables with retained data reject opening through the native factories. A database using the legacy format requires an explicit migration before the defaults can write to it. Cloudflare also rejects legacy KV recovery records under `tardie:watchdog:`, `tardie:scheduler:` or `tardie:scheduler-generation` before admitting work or acknowledging SQL recovery. Rejection preserves that data.

## Platform policies and observation

The native factories accept existing `checkpointTree` layout and read-cache settings for Grove. `checkpointTree.collectEvery` defaults to the exported `DEFAULT_CHECKPOINT_COLLECT_EVERY` of 32 checkpoints. `checkpointTree.scheduler` selects the Effect scheduler for journal I/O and defaults to `DEFAULT_CHECKPOINT_SCHEDULER`. Byte checkpoint envelopes and Grove documents have separate chunk settings as described above.

Bun enables WAL unless `disableWAL` is true and uses immediate native transactions. `busyTimeout` accepts the existing duration input and defaults to the exported `DEFAULT_BUN_BUSY_TIMEOUT_MS` of 5,000 milliseconds. SQLite's timer range bounds its effective value. `journal.sqlite` exposes the effective `busyTimeoutMs` and `wal` settings. Native Bun journals reject Effect SQL name transforms and span attributes explicitly.

`observeBunThread` and `observeBunSupervisor` read committed native records without opening the actor or creating tables. They reconstruct chunked bytes, validate their metadata and digest, and retain legacy read support. A database containing both formats for the observed actor rejects observation. Bun host backups capture SQLite snapshots containing Grove data, journal chunks, recovery rows and receipt indexes. Restoring the snapshot preserves document references and deduplication receipts.

## Delivery receipts

The journal implements Core's indexed message journal and thread journal surfaces: `readMessage(id)`, `acknowledge`, `readFirst` and `readVersion`. Message envelopes validate `MessageMetadata` and the framework inbox event before writing. `stored_journal_messages` maps each actor's message identity to its journal sequence; the primary key rejects duplicate identities. Its insert shares the native transaction with the logical record, payload chunks, checkpoint, recovery records and Grove ownership. A failed index write leaves no accepted message or partial publication.

Core's existing `receive` path compares a repeated identity's input and sender against the indexed record. An identical delivery runs `acknowledge` and returns the original receipt position. Reusing that identity with different input or delivery context raises `MessageConflict`. `readMessage` reconstructs and digest-checks its record before returning, validates the envelope and rejects dangling or mismatched index pointers. Chunked message payloads retain these checks across checkpoint and restart.

`readFirst` loads the creation record. `readVersion` reads the current append position, accepted input count and latest `ThreadCreated` or `ThreadUpdated` record through the lifecycle index. These reads avoid decoding unrelated history; receipt lookup restores only the indexed message. Closing the journal rejects these operations through the same lifecycle guard as other reads.

Opening an existing stored-value journal builds its receipt index once per actor. The backfill reads one event at a time, verifies available digests and chunk metadata, validates message envelopes and rejects duplicate identities. `stored_journal_message_indexes` records completion in the same native transaction as the index entries. Failure rolls back the backfill and leaves the journal records intact. Existing legacy adapter data still requires separate format conversion.

## Durable recovery

The optional `scheduler` configuration accepts a physical `alarm`, a `deliver(wake)` callback and Core's scheduler `policy` overrides. The returned `journal.scheduler` exposes registration, cancellation, restoration and alarm delivery. Retry events register durable wakes automatically; settlement and terminal cancellation remove their retry wakes in the journal transaction. Wake records and generation counters live in actor-scoped `stored_scheduler_wakes` and `stored_scheduler_generation` tables. A replacement receives a new generation so a stale delivery cannot acknowledge it. Delivery runs outside the native transaction.

The optional `watchdog` configuration requires `scheduler`. It accepts a `target` and Core's `createWatchdog` options, including `recover`, `invalidate`, `version` and `policy`; `{ target, instance }` enlists an existing watchdog. The returned `journal.watchdog` exposes the existing recovery lifecycle. Journal appends admit recovery, advance progress cursors on settlement and adopt interpreter versions from `ThreadUpdated` in the same native transaction as Grove publication and payload writes. Records live in actor-scoped `stored_watchdog_entries`. `recoveryActor` selects their namespace and defaults to the journal actor. Cloudflare object hosts and recovery adapters share the exported `CLOUDFLARE_RECOVERY_ACTOR` namespace within each object. Recovery charges its durable attempt budget before calling `recover`. Exhaustion remains blocked across new admissions; explicit resume or interpreter version adoption renews the budget.

The host routes scheduled wakes by their target. Retry wakes identify `{ owner: "effect", ref }` and must resume the corresponding actor's work; `{ owner: "watchdog" }` wakes invoke `journal.watchdog.alarm`. On startup, the host invokes `journal.watchdog.restore` when configured before dispatching `journal.scheduler.alarm`. Journal reads restore the scheduler's physical alarm from persisted wakes. Recovery remains a host lifecycle responsibility.

Native transaction callbacks perform synchronous SQL and Core bookkeeping. The exposed `journal.watchdogStorage.transaction` supports Core's watchdog storage contract; its callback must finish synchronously. Suspension rejects the transaction and rolls back its writes. Handles expire when the callback finishes. Network calls, waiting and recovery execution belong outside this callback.

Physical alarm updates happen after the native commit. The optional `flush` effect runs before alarm synchronization and before an append acknowledges success; Durable Object callers can supply `Effect.tryPromise(() => storage.sync())`. The Cloudflare factories supply the existing retry-aware storage flush. `journal.acknowledge` flushes storage and synchronizes the alarm before confirming an existing provisioning or message receipt. A semaphore shared by native connection identity serializes append, acknowledgement, scheduler and watchdog mutations through the flush and alarm update, preserving the earliest wake when alarm I/O suspends. If flush or alarm synchronization fails, the durable commit remains recorded and the call reports failure. Reopening and restoring re-arm its persisted wake; retrying the append with its old journal position conflicts. A pre-commit failure rolls back journal records, chunks, references and recovery records together.

## Verification

`test/bun/stored-journal.test.ts` exercises real actor checkpoints, restart and both effect execution and cancellation cleanup with old input retained after current state advances. It also covers acceptance/completion rollback, stale head publication, projection holder release, Unicode actor ownership, enclosing-transaction rejection and format rejection in both directions. `test/bun/stored-journal-chunks.test.ts` covers UTF-8 payloads, partial chunk rollback, checkpoint replacement, corruption rejection, configurable row budgets and reopening existing inline rows. `test/bun/stored-journal-recovery.test.ts` runs the shared scheduler properties and verifies atomic admission, progress and version adoption, budget exhaustion, reopening, post-commit alarm failure, concurrent alarm synchronization and synchronous callback enforcement. `test/bun/stored-journal-delivery.test.ts` exercises actual actor deduplication across checkpoint and restart, index failure rollback, invalid envelopes, bounded identities, thread initialization and version adoption, corrupted pointers and transactional backfill. `test/workerd/stored-journal.workers.ts` checks acceptance rollback, chunked Grove nodes, eviction, old-input reopening, completion and collection against native Durable Object SQLite. It also writes 3 MiB event, input and checkpoint payloads, rolls back a partial chunk write, checks watchdog admission rollback and alarm restoration, and verifies chunked receipt lookup and index rollback across eviction.


## Completed act results

Completed act results remain readable through `handle.result`. Core moves fulfilled payloads at or above `DEFAULT_EFFECT_RESULT_COLD_MIN_BYTES` into Grove and keeps their references and duplicate-delivery digests in operation metadata. The default is 2 KiB; `effectResult.coldMinBytes` overrides it independently of `effectInput.digestMinBytes`. Reading `status` does not load a cold payload. Reading `value` materializes and validates it against the act's success schema. The result object does not cache the materialized value; application code can retain values it reads.

Local operation holders protect results before checkpointing, and checkpoint owners retain their references across restart. Journal events, result dependencies and ownership changes commit atomically. Checkpoint `maxBytes` includes referenced result payload sizes. An inline result restored from a checkpoint can move to cold storage without losing readability.
