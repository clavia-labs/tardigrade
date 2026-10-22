# Supervisor directory

The supervisor journal records `ThreadRequested`, `ThreadRegistered`, and `ThreadFailed` events. The directory derives `thread(id)` members for allocations and status, and `threadByName(threadNameKey(parent, name))` members for persistent name claims. A plain `pendingThreads` atom holds requested IDs, and the actor view exposes these IDs as `view.pending`.

Allocation reads the requested name claim, candidate identity, and registered parent. An instance lock serializes name and identity admission with the append. Per-thread reducers permit an identical failed allocation to be requested again and reject incompatible lifecycle transitions. Name reducers reject a second identity claiming an existing parent and name. The identity atom checks actor and instance consistency. Parent registration and depth are checked on admission and during replay.

Provisioning reads the pending IDs and their thread members. Requests retain their absolute journal positions as origins, and completed requests leave the proposal cache. Runtime replay flushes unused atom removals between historical records, and snapshot publication batches bindings and projections at one journal prefix. Finite-retention family values are reconstructed when a snapshot registry is reopened.

`Supervisor.store(instance)` returns keyed and paginated selections:

```ts
const directory = yield* supervisor.store(instance)
const allocation = directory.thread(id).get()
const claimedId = directory.threadByName(parent, name).get()
const page = directory.page({ limit: 25 }).get()
const next = page.next === undefined
  ? undefined
  : directory.page({ after: page.next, limit: 25 }).get()
```

`directory.thread(id)` and `directory.page(options)` expose `ThreadMetadata`, which excludes `initialState`. Provisioning and conflicting-initial-state checks read the full allocation internally. The underlying member still retains its seed while in use; public metadata selections do not split journal storage.

Pages are ordered by thread ID in Unicode scalar order and use an exclusive `after` cursor. A page defaults to `DEFAULT_SUPERVISOR_PAGE_SIZE`, which is 100, and returns `next` when more keys exist. The index supplies committed keys within the reader's snapshot; the runtime merges keys from prepared events. Unsubscribed page selections and their members can be evicted. `directory.threads` and the exported `threads` atom remain explicit full-directory inspection surfaces and materialize all allocations when read. Normal allocation, lookup, provisioning, and Cloudflare placement checks use keyed selections. The public `supervisorActor` retains its full-directory `view.threads` contract for direct actor consumers; `createSupervisor` uses an internal family-backed actor with a pending-only view.

Supervisor checkpoints carry `SUPERVISOR_CHECKPOINT_TAG`, which is `host.supervisor.families/1`. SQL readers select this tag from checkpoint metadata before loading chunks. Untagged whole-directory checkpoints are ignored and the directory is rebuilt from the original journal through bounded reads. Subsequent checkpoints use the tagged layout. Custom journals that ignore tag selection are filtered by the supervisor after their read; they must implement metadata filtering to avoid loading an incompatible payload. Event names, thread IDs, name claims, and provisioning origins remain journal-derived.

`DEFAULT_SUPERVISOR_JOURNAL_READ_BATCH_SIZE` is 16 records. Set `journalReadBatchSize` on the supervisor or host to change its replay pages. `DEFAULT_INVOCATION_INDEX_BATCH_SIZE` is also 16; set `invocationIndexBatchSize` on SQL journal or platform host options to change its resumable invocation-index backfill pages. `familyIndexBatchSize` controls family index pages independently. These policies affect temporary memory and database work, and do not truncate replay or member state.

The opt-in directory oracle in `packages/platform/bench/directory` checks the production supervisor with a 4,098-record, approximately 200 MB journal. Its acceptance budgets cover sampled peak heap, retained heap, backing storage, and growth against a smaller journal. It also checks named allocation, parent name separation, pending recovery, retry, initial-state preservation, cold reopen, and unchanged seed journal bytes. Table-only `actor_directory` registrations from maintenance releases require a separate migration into journal events.

The family constructor remains available through `tardie/experimental`. The stable supervisor exposes `SupervisorPageOptions` and ordinary thread selections; its family objects remain internal to the main entry point. Experimental family types are absent from the supervisor store contract.

The compatibility floor is the complete supervisor journal: event schemas, thread coordinates, parent-scoped name claims, and absolute provisioning origins. Family indexes are disposable projections, and custom journals without family lookup methods use replay scanning. Keep journal history when replacing this implementation. A replacement selects its own checkpoint layout tag and rebuilds from the original events when the stored tag differs; removing the family implementation does not require rewriting allocation events. This permits a future implementation replacement; older binaries that do not select checkpoint layout tags require separate downgrade handling.
