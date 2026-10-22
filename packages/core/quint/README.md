# System contracts

The specs describe contracts across atoms, runtime admission, storage, execution, and host recovery. A guarantee at one boundary supplies an assumption at the next. Each row below names that dependency. Guarantees apply within the abstraction and bounds declared by each spec; a checked leaf model alone does not establish system composition or TypeScript conformance.

```text
                           per-thread journal
                                  |
               full replay / checkpoint + suffix
                                  |
                     durable atoms -> derived graph
                                  |
                       proposal {act, input}
                                  |
                 serialized acceptance allocates ref
                                  |
                commit(request + domain follow-ups)
                         /                 \
       atoms observe {ref, act}    runtime retains input
                                             |
                              crash -> reconstruct -> verify
                                             |
                                    execute accepted ref
                                     /              \
                             immediate          deferred handle
                                |                /          \
                                |          local restart  remote observe
                                |                \          /
                                |                 result admission
                                \                       /
                                 terminal + callbacks
                                           |
                               commit -> publish -> release input
                                           |
                                      durable atoms

host: durable wake -> reopen thread -> recover unfinished work
cancel: stop fence -> terminal callbacks + owned cleanup -> drain
invoke: stable key -> receiver deduplication -> durable reply
```

`ref = {seq, atom, act}` identifies an accepted effect across every atom. `seq` is its acceptance position; `atom` identifies the registered atom; `act` identifies the operation. Framework acceptance retains the originating journal position to bind reconstructed requests without using their inputs as identity. An input digest validates a reconstructed proposal. It supplies no execution payload or additional identity.

## Contracts and dependencies

| Boundary | Guarantee and spec | Required assumptions |
| --- | --- | --- |
| Coordinate allocation | Fresh refs remain distinct, [effectIdentity](effectIdentity.qnt), `uniqueReferences`; acceptance binds journal position, [proposalCheckpoint](checkpoint/proposalCheckpoint.qnt), `allocationAtomic` | Serialized acceptance, duplicate rejection, replay preserves stored coordinates; coordinate codecs remain implementation obligations |
| Durable atom recovery | Checkpoint plus suffix equals full replay, [atomCheckpoint](checkpoint/atomCheckpoint.qnt), `recoveryEquivalent` | Codec preserves state, reducer and configuration agree, journal prefix stays immutable |
| Graph recovery | Equal roots yield equal derived graphs, [graphCheckpoint](checkpoint/graphCheckpoint.qnt), `graphEquivalent` | Recovered roots are equal, projections are deterministic, dependencies are topologically ordered, configuration agrees |
| Lazy discovery | An unread atom obtains a seed or replays the missing prefix, [lazyAtomCheckpoint](checkpoint/lazyAtomCheckpoint.qnt), `readyEquivalent` | Capture includes the atom, or its original prefix remains readable; suffix-only recovery cannot supply absent roots |
| Commit and publication | Committed state survives failed preparation; publication follows complete storage, [runtimeCheckpoint](checkpoint/runtimeCheckpoint.qnt), `visibleEquivalent`, `rollbackStable`, `committedCandidate`; acceptance survives reopening, [proposalCheckpoint](checkpoint/proposalCheckpoint.qnt), `recoveryMatchesRequest` | Atomic journal/checkpoint writes, persistence failure forces reopening, reconstructed proposals agree |
| Runtime record retention | Volatile records are limited to the current batch, [runtimeCheckpoint](checkpoint/runtimeCheckpoint.qnt), `retentionBound`; fair release proceeds with active work and without a checkpoint, `publicationReleased` | Fixed-size runtime frames in this abstraction, active work retained separately, release independent of checkpoint eligibility; TypeScript reachability and byte growth require implementation checks |
| Effect recovery | Retry identity and deferred ownership survive replay, [effectRecovery](checkpoint/effectRecovery.qnt), `retryIdentity`, `localRestartOnly` | Durable lifecycle records, preserved refs and handles, local ownership distinguishes restart from remote observation |
| Execution defects | Defects remain distinct from declared failures and stop domain execution; unresolved callers fail, [effectRecovery](checkpoint/effectRecovery.qnt), `blockedIsDurable`, `terminalNotExecuted`, `terminalReachesCaller` | Durable defect commit before publication, complete replay, eventual availability and fair caller observation; terminal threads retain the journal suffix |
| Promise admission | Result follows successful effect settlement; correlated callbacks share its batch, [promiseDelivery](checkpoint/promiseDelivery.qnt), `settlementFirst`, `batchExactlyOnce` | Serialized admission, atomic callback batch, retry early delivery, suppress already terminal groups independently |
| Work obligations | Execution and cleanup share admission, outcome recording, crash recovery, and timeout transitions, [workLifecycle](workLifecycle.qnt), `inputRetained`, `quiescenceSound`, `attemptsEnd` | Atomic durable acceptance and outcomes, charged attempt budgets, eventual availability and fair outcome recording; producer stop acknowledgement is external |
| Shared lifecycle | Acceptance, commit/publication, graph recovery and producer ownership coexist, [lifecycleCheckpoint](checkpoint/lifecycleCheckpoint.qnt), `invariant` | Complete durable roots, deterministic reconstruction, atomic writes and callback batches; finite single-effect abstraction |
| Input representation | Acceptance observation ignores payload and inline/digest choice, [effectInput](effectInput.qnt), `observe`; execution checks reconstructed act/input, [inputLifecycle](checkpoint/inputLifecycle.qnt), `verifiedExecution` | Digest equality identifies equal canonical inputs, reconstruction has all required domain state and configuration |
| Input lifetime | Live execution and nonterminal obligations retain full input; crashes require rehydration, [inputLifecycle](checkpoint/inputLifecycle.qnt), `inputRetained` | Verify before dispatch/restart and before input-dependent preparation; cancellation cleanup requires an additional lifetime obligation |
| Cancellation | Completion and cancellation are exclusive; owned forwarding is isolated, [cancellation](cancellation.qnt), `terminalExclusive`, `cancellationIsolation` | Durable ownership, atomic local terminal decisions; cross-log ownership requires reconciliation; remote abort acknowledgement is external |
| Actor stop | Stale proposals are fenced and pending tools drain, [actorCancellation](actorCancellation.qnt), `acceptanceFenced`, `settlementSound` | Accepted work is assigned to the turn, callbacks and tool obligations survive crashes |
| Terminal delivery | Terminal callbacks occur at most once; unrelated result groups survive suppression, [terminalDelivery](terminalDelivery.qnt), `callbackAtMostOnce`, `validBatchPreserved` | Terminal decision and domain callbacks share a commit, each result group has independent ownership |
| Thread invocation | Reply obligation survives receiver acknowledgement, [messageReply](invocation/messageReply.qnt), `obligationConserved`, `replyRecoverable`; replay avoids duplicate logical execution, [invocationReplay](../../platform/quint/invocationReplay.qnt), `oneLogicalExecution` | Stable invocation key, receiver deduplication, durable dependency and reply; eventual transport and recovery for progress |
| Interpreter adoption | Version changes are recorded and recovery budgets renew with a fresh fence, [interpreterVersion](../../platform/quint/interpreterVersion.qnt), `invariant` | Atomic version event, budget reset and wake; version identity remains stable across same-build restarts; finitely many changes and fair service for eventual stop |
| Host wake | Pending work remains covered, [watchdog](../../platform/quint/watchdog.qnt), `wakeCoverage` | Atomic admission/wake, replacement wake before detached work, interrupted delivery remains retryable; eventual delivery and a crash-free suffix for progress |
| Recovery limits | Persisted accounting bounds attempts and eventually stops, [recoveryBudget](../../platform/quint/recoveryBudget.qnt), `boundedAttempts`, `eventualStop` | Charge before execution, durable counters and deadlines, fair alarm delivery and attempt timers |
| Deferred host work | Local fibre exit is accounted for; remote work parks with a stable deadline, [promiseLifecycle](../../platform/quint/promiseLifecycle.qnt), `fibreExitAccounted`, `noRemoteBurn`, `firstDecisionWins` | Durable result source and deadline, local supervision, fair recovery and result delivery; timeout supplies no remote abort acknowledgement |

The scheduling models have different progress contracts: watchdog settlement assumes terminating effects; bounded recovery permits explicit failure after a budget or deadline. Input safety composes with either outcome. An alarm guarantees an opportunity to recover work; executing remote work exactly once additionally requires a replay-safe executor or receiver deduplication.

## Obligations and attempts

```text
operation: stable ref + durable serialized input
  |
  +-- execution obligation --+
  |                         |
  +-- cleanup obligation ---+--> shared attempt transitions
                                  begin -> success / failure / died / timeout
                                                |
                                  record outcome + apply discharge rule
                                                |
                                  retry, remain blocked, or discharge

release input only when every obligation and producer is finished
```

[obligation](obligation.qnt) defines pure transitions shared by both entries in [workLifecycle](workLifecycle.qnt). Cancellation creates cleanup before discharging execution. Every attempt has an identity formed from the operation reference, obligation kind, and charged attempt number. Attempts use the accepted serialized input and the current runtime image. Stale results cannot settle a later attempt.

Execution accepts terminal outcomes as logical completion. Cleanup requires success; typed failures retry within the budget, defects await explicit resume, and budget exhaustion remains blocked with input retained. Timeout records an attempt outcome without claiming that its producer stopped. Cleanup admission and physical input release still require producer quiescence. This is a proposed framework contract, including charged attempt budgets and explicit resumption. The implemented retry-boundary deadline contract is checked separately by [attemptDeadline](attemptDeadline.qnt). [cancellation](cancellation.qnt) contains unsafe lifecycle variants for hung submission, hung cleanup, volatile cleanup death, and unlimited typed-failure retries.

The finite instance uses one operation, two input values, two runtime images, and a two-attempt budget for each obligation. TLC exhaustively checks safety and `attemptsEnd` over 13,768 reachable states in this combined instance. The negative steps `stepEarlyRelease`, `stepTimeoutAcknowledgesStop`, and `stepFailedCleanupDischarges` each produce their intended invariant counterexample. Attempt completion assumes eventual runtime availability and fair deadline/outcome recording. Successful cleanup has no unconditional liveness guarantee. Clock durations, actual external side effects, byte codecs, checkpoint ordering, and TypeScript refinement are outside this composition.

`checkpointProjection` groups the accepted identity and serialized input with separate execution and cleanup state. `checkpointRoundTrip`, `checkpointCrashStable`, and `checkpointCleanupPreserved` check that the projection preserves durable obligations while excluding volatile attempt state. The TypeScript checkpoint codec stores this nested operation shape as version 3 and imports version-2 effect and promise entries through an adapter; [pendingInputRecovery](../../platform/test/properties/runtime/pending-input-recovery.ts) checks migration through real SQLite reopening.

[InputRetention](../tla/InputRetention.tla) supplies a separate TLAPS deductive proof for arbitrary references and serialized inputs. Its `cleanupAcknowledged` set projects successful `CancellationSettled` outcomes. Retry scheduling, final typed failure, and `CancellationDied` leave cleanup owed and input retained. The proof abstracts retry policy and terminal blocking; this correspondence is an intended projection rather than a mechanically checked refinement of Quint or TypeScript.

Checkpoint replay, local versus remote producer ownership, forwarding, host wake coverage, and no-progress accounting retain their separate models. Their additional state and guarantees require explicit composition before deletion or a combined system claim.

## Attempt deadlines

[attemptDeadline](attemptDeadline.qnt) checks default and configurable deadlines for execution and cleanup. A deadline requests local interruption before delivering `AttemptTimedOut` to the retry decision. The decision either records `RetryScheduled` with the consumer's reason or records a final rejected settlement. Framework-owned direct and deferred attempt deadlines persist the serialized `AttemptTimedOut` rejection, which `ActFailure` exposes alongside cancellation and deferred timeout without decoding it through the act's declared error schema. Cleanup rejection retains input and admits a late producer handle; successful cleanup permits release. Timeouts supply no acknowledgement that remote work stopped. The fixture receiver deduplicates retried submissions by the original reference and serialized input.

```text
attempt -> success
        -> failure -> decide -> RetryScheduled -> wait -> attempt
        -> timeout -> interrupt local wait -> decide
        -> defect -> EffectDied / CancellationDied
```

`EffectExecution.retry(work, { attemptTimeoutMs, decide })` applies a fresh deadline to each invocation. `CancellationOptions.attemptTimeoutMs` applies the same mechanism to producer handoff, promise-observer cancellation, and the act's cancellation callback. Omission uses the exported `DEFAULT_ATTEMPT_TIMEOUT_MS` of 60 seconds; `null` disables it. The actor and host `attemptTimeoutMs` option overrides the fallback for direct work, submission, local producer fibers, and cleanup. An explicit retry boundary owns its attempt deadlines and disables the enclosing fallback. Retry waits, decision callbacks, and durable commits are outside the deadline. Interruption waits for finalizers; an uninterruptible callback or hanging finalizer can still prevent progress. `PromiseOptions.timeoutMs` remains the separate deadline for a deferred result after submission.

TLC checks safety and conditional `attemptsEnd` across all 625 reachable states. Six scenario tests cover execution retry, cleanup retry, final rejection, an unbounded attempt, local interruption before a decision, and late producer handoff after final cleanup rejection. Three unsafe variants expose early input release, timeout discharging cleanup, and a discarded late handle. Liveness assumes eventual runtime availability, deadline delivery, local interruption completion, and retry-decision completion. Crashes are modeled between attempts; process loss during an unresolved remote request, arbitrary finalizers, and TypeScript refinement are outside this instance.

[attemptDeadlineLifecycle](../../platform/test/properties/runtime/operation-lifecycle.ts) exercises the corresponding boundaries with generated serialized inputs, deadlines, retry decisions, and producer handoff on Bun HTTP/SQLite and real workerd Durable Objects. It checks recorded retry reasons and counts, original input after restart with a changed proposal, receiver execution counts and outputs, cancellation acknowledgements, final input retention, and no terminal replay. The projection is maintained by hand and supplies no mechanical refinement proof.

[operationRace](../../platform/test/properties/runtime/operation-lifecycle.ts) crosses five controlled orderings with successful commits, real SQLite rollback, and a lost acknowledgement after successful commit. Journal barriers hold cancellation, handle admission, retry scheduling, or cleanup acknowledgement while the original response returns or the attempt deadline expires. Controlled timer registration checks both handoff-first and timeout-first orderings at the same clock timestamp; an accepted cancellation suppresses subsequent execution retries. The fifteen cases run against Bun HTTP/SQLite and real workerd Durable Objects. Rollback preserves the exact durable prefix and serialized input, including input chunks deleted before an injected metadata-delete failure. A lost acknowledgement can advance durable state while the old runtime retains its prior view; that runtime reports `ActorCommitError` and requires reopening. Recovery uses the original input and external identity, records cleanup once, releases input only after its durable acknowledgement, and performs no acknowledged work after checkpoint recovery. These deterministic orderings extend concrete boundary coverage without proving all schedules or mechanical correspondence with the formal models.

## Stream deadlines

`withStreamTimeout` in core's execution transport bounds the first upstream chunk and the gap between subsequent chunks. The exported `DEFAULT_STREAM_TIMEOUT` sets both to 60 seconds; call-site overrides replace each bound, and `null` disables an individual bound. `StreamTimedOut` identifies the expired bound and its configured duration. A partial stream fails through the effect error channel and can enter the existing durable retry decision. Stream deadlines request local interruption without acknowledging that the remote producer stopped.

The agent's inference adapter uses the core transport primitive with the selected model's first-chunk and idle settings, which default to 90 seconds. Inference and compaction use the core retry boundary with an exported 90-second `DEFAULT_MODEL_TIMEOUT_MS`; the layer's `timeoutMs` or selected model's `attemptMs` overrides it. Inference also supplies its deferred-result deadline, and `promiseTimeoutMs` overrides that independently. `Model.call` is the attempt body; the act adapter owns its overall deadline. The independent model package retains its standalone request helpers without depending on core.

[streamDeadline](streamDeadline.qnt) checks first-chunk expiry, idle expiry, idle-clock reset, rejection of partial completion, and discarded late chunks. TLC checks safety and conditional `streamsEnd` across all 110 reachable states. Four scenarios pass; two unsafe variants expose timeout being mistaken for successful completion and missing idle-clock reset. Liveness assumes fair clock delivery and completed local interruption. Remote cancellation, wire buffering, recovery, and TypeScript refinement remain outside this finite instance.

[streamDeadlineLifecycle](../../platform/test/properties/runtime/operation-lifecycle.ts) consumes actual HTTP response streams from the independent fixture. Generated cases stall before the first chunk or between chunks, record the typed timeout and retry reason, restart with a changed proposal, and finish from the original serialized input. Receiver history records stream openings, chunks, closure, cancellation, and failure independently of the actor. Local interruption discards late chunks even when the receiver has not observed cancellation; teardown closes remaining fixture streams. Retried streams reuse the accepted external job without repeating its execution or output.

## Operation recovery boundaries

[operationRecovery](operationRecovery.qnt) checks acceptance through normal completion or cancellation, late remote-handle admission, cleanup retry, forwarding to a child, execution death, crash, recovery, and input release. `retained`, `covered`, `handleAdmitted`, and `cleanupComplete` connect the boundaries: runnable work retains wake coverage, unfinished work retains input, and successful cleanup accounts for the final admitted handle and required forwarding. TLC checks all 178 reachable states; the three unsafe variants expose lost wakes, execution-death blocking, and discarded late handles.

[operationLifecycle](../../platform/test/properties/runtime/operation-lifecycle.ts) projects runtime observations onto the same state fields and checks the same predicates with generated inputs, terminal results, forwarding, and crash points. It drives the real runtime and watchdog over Bun and workerd SQLite, including checkpoint reopening and unchanged accepted identities after proposal changes. The predicates and projection are maintained explicitly; this correspondence is not a mechanically checked refinement or generated trace equivalence.

The [native lifecycle tests](../../platform/test/workerd/checkpoint-storage.workers.ts) connect production journal admission, scheduler entries, watchdog records, physical DO alarms, native eviction, and abort. Alarm-owned cleanup recovery observes storage without reopening the runtime or calling resume. An execution defect stops domain work while outstanding cleanup retains recovery coverage; the original defect becomes terminal again after cleanup finishes. Stopped inputs remain retained while cleanup can still forward cancellation to another accepted operation.

Graceful native-eviction cases explicitly set `attemptTimeoutMs: null` so an active JavaScript deadline timer does not prevent the DO from becoming idle. Hard-abort cases retain the default deadline. Generated deadline properties separately verify configured timers, durable retry wakes, and reopened attempts against real workerd storage and an independent service DO.

[effectService](../../platform/test/fixtures/effect-service.ts) supplies an independent receiver with durable jobs keyed by the accepted effect reference. The Bun adapter uses an HTTP server, a separate SQLite database, and timers; the workerd adapter uses a separate Durable Object and alarms. Configurable start, execution, cancellation, and response intervals control real state changes, while response barriers reproduce lost acknowledgements. The receiver records submissions, execution starts, outputs, cancellation requests, acknowledgements, and transition history. Generated lifecycle tests observe those records and deliver actual service results through `Promises`.

Native tests withhold a submission response, abort the actor, and verify that resubmission reuses the existing job without another execution. Cancellation tests stop the external job while withholding its acknowledgement, abort both Durable Objects, and verify that cleanup retries preserve input until acknowledgement. These checks exercise the fixture receiver's idempotency contract; arbitrary external executors require their own equivalent contract.

The finite recovery model abstracts serialized values and hashes, which remain covered by `inputLifecycle` and codec properties. Process loss during an unresolved external submission requires executor-specific idempotency or handle discovery and remains outside this model. [attemptDeadline](attemptDeadline.qnt) checks deadline decisions separately; explicit resumption of final cleanup failures remains a separate obligation.

## Executable composition

```text
inputLifecycle
  +-- lifecycleCheckpoint       imported transitions and invariant
  `-- effectInput               representation and observation functions
       `-- effectIdentity       shared Ref and coordinate constructor
```

Every `inputLifecycle` transition executes an imported lifecycle action. Hydration and release leave lifecycle state unchanged. The combined invariant checks journal acceptance positions, unchanged observer output, payload independence, verified execution, retained input, and the imported recovery/commit properties in the same reachable state space.

The finite instance has four journal entries, one active effect, two atom names, two act names, and two input values. Every acceptance chooses its atom and inline/digest form; its act agrees with the reconstructed proposal. `original(position)` is a deterministic witness for proposal reconstruction; it assumes the atom and graph recovery contracts rather than importing their transition systems. Hash collisions, canonical JSON, byte size, arbitrary concurrency, and concrete codecs are outside this abstraction.

Preparation while a live request is nonterminal requires its input to be loaded. This guard abstracts input-dependent callbacks and strengthens the imported lifecycle's allowed behavior. The composition establishes safety under that guard; it supplies no equivalence theorem for all leaf-model traces and no liveness theorem for hydration.

The remaining rows are standalone models with corresponding contracts. Their state variables and transitions are not mechanically linked into this composition. Cancellation cleanup and host scheduling require explicit adapters before their combined behavior can be claimed as checked.

## Runtime frames and publication

[runtimeCheckpoint](checkpoint/runtimeCheckpoint.qnt) distinguishes the committed runtime frame, a candidate frame, and persisted storage. Runtime frames contain actor state, a consumed position, and an active work reference. Checkpoints contain actor state and position and require quiescence. Preparing a batch leaves committed state visible. A successful commit persists settlement and callback events atomically before publication. Releasing the batch and previous frame requires no checkpoint and preserves active work.

```text
committed frame + batch -> candidate frame
                               |
                          journal commit
                               |
          success -> publish -> release batch and previous frame
          failure -> retain previous frame -> recover from journal

checkpoint capture: requires quiescence
record release:     allowed while work remains pending
```

A failure before storage preserves both committed state and storage. A lost acknowledgement after storage retains the previous visible frame while recovery obtains the durable result. Recovery folds records directly into state from the checkpoint position and retains no replay buffer. The journal remains available for every recovery path.

The finite instance contains four journal records, two Boolean actor roots, batches of at most two records, and one active work reference. TLC checks safety and conditional publication/recovery progress over 3,725 reachable states, including recovery from 280 initial journal/checkpoint combinations. Seven scenarios cover rollback, pending work during release, atomic callbacks, acknowledgement loss, preparation and publication crashes, and checkpoint suffix replay. Progress assumes no further crashes, fair release, and successful, fairly scheduled recovery. The memory bound describes modeled record ownership; arbitrary actor-state size, lazy atom hydration, external execution, cleanup payloads, and TypeScript heap reachability remain outside this instance.

| Unsafe initializer | Expected counterexample |
| --- | --- |
| `initEarlyPublication` | `visibleEquivalent`: candidate state appears before durable commit |
| `initFailedRollback` | `rollbackStable`: a failed write changes the committed frame |
| `initRetainedHistory` | `retentionBound`: released batches accumulate in runtime memory |
| `initPartialCommit` | `committedCandidate`: settlement persists without its callback event |
| `initLostWork` | `visibleEquivalent`: releasing a batch drops active work |
| `initCheckpointRelease` | `publicationReleased`: pending work blocks record release indefinitely |

## Open joins and implementation checks

| Obligation | Evidence required |
| --- | --- |
| Reconstruction completeness | Seed every durable atom or replay its missing prefix; `lazyAtomCheckpoint.initSkipPrefix` exposes the suffix-only failure, also identified in `src/runtime/replay.ts` |
| Cancellation lifetime | Keep reconstructible input until executor-owned cleanup and forwarding obligations finish, even after the cancellation terminal record |
| Coordinate and payload codecs | [referenceCoordinates](../../platform/test/properties/runtime/reference-coordinates.ts) and [inputRepresentation](../../platform/test/properties/runtime/input-representation.ts) check owner recovery, distinct coordinates, canonical hashing, observation isolation and mismatched reconstruction on Bun and workerd |
| Reducer isolation | [EffectAcceptance](../src/runtime/effect-request.ts) excludes stored input; [EventLog](../src/services/event-log.ts) exposes projected events, records and lifecycle lookups; the actor import guard rejects stored request schemas |
| Behavioral equivalence | Drive the same domain flow through inline and digest storage, including crash/reopen; compare domain output, refs and terminal decisions |
| Host composition | Connect pending runtime obligations to durable wake coverage and retry accounting; distinguish eventual settlement from bounded failure |
| Checkpoint transport | [checkpointChunks](../../platform/test/properties/runtime/checkpoint-chunks.ts) checks byte identity and malformed chunk rejection; [checkpointStorage](../../platform/test/properties/checkpoint-storage.ts) checks atomic replacement, rollback, reopening and corruption rejection on Bun and workerd SQLite |
| Storage growth | The [10k-event stock agent flow](../../platform/test/workerd/input-digest.workers.ts) samples journal bytes, enforces checkpoint BLOB row limits and reopens a chunked checkpoint; symbolic models establish no byte-growth bound |

Journal mutation is restricted to append in the composed lifecycle, so committed prefix records remain unchanged through its transitions. SQLite transaction semantics, chunked checkpoint storage, and byte immutability still require concrete storage verification. These checks reuse existing fixtures where possible; each covers a boundary that the symbolic model assumes.

## Checked instance

TLC exhaustively checks the combined finite invariant over 275,989 reachable states. The named negative steps deliberately remove one guard and must produce counterexamples.

| Step | Property | Result | Reachable states explored |
| --- | --- | --- | --- |
| `step` | `invariant` | Pass | 275,989 |
| `stepWithoutVerification` | `verifiedExecution` | Counterexample: a different act is admitted after crash/reconstruction and dispatched | 2,164 |
| `stepEarlyRelease` | `inputRetained` | Counterexample: committed nonterminal work loses its loaded input | 38 |

A seeded simulation also checks 2,000 traces of 60 transitions with `invariant`. These results establish safety for the declared finite abstraction. They supply no cryptographic proof, TypeScript refinement, or end-to-end progress guarantee.

## Reproduce

Use Quint 0.32.0 and run backend checks from a temporary directory so generated artifacts remain outside the repository. Java must be on `PATH`; the compiler requires localhost access for its Apalache server. The platform [verification runner](../../platform/quint/verify.py) checks its scheduling models and requires their named negative cases to fail.

```sh
quint typecheck packages/core/quint/checkpoint/runtimeCheckpoint.qnt
quint test packages/core/quint/checkpoint/runtimeCheckpoint.qnt
runtime_model="$PWD/packages/core/quint/checkpoint/runtimeCheckpoint.qnt"
runtime_checks=$(mktemp -d /tmp/tardigrade-runtime.XXXXXX)
(
cd "$runtime_checks"
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
quint verify "$runtime_model" --backend tlc --invariant invariant
quint verify "$runtime_model" --backend tlc --init initRecovery --step stableStep --invariant invariant --temporal publicationReleased,recoveryProgress
)
```

Check each unsafe initializer with its named invariant from the table. `initCheckpointRelease` uses `--step stableStep --invariant invariant --temporal publicationReleased`; it must report a temporal counterexample. The other five must report invariant counterexamples, rather than checker errors.

```sh
quint typecheck packages/core/quint/checkpoint/inputLifecycle.qnt
input_model="$PWD/packages/core/quint/checkpoint/inputLifecycle.qnt"
input_checks=$(mktemp -d /tmp/tardigrade-input.XXXXXX)
cd "$input_checks"
quint verify "$input_model" --backend tlc --invariant invariant
quint verify "$input_model" --backend tlc --step stepWithoutVerification --invariant verifiedExecution
quint verify "$input_model" --backend tlc --step stepEarlyRelease --invariant inputRetained
```

The positive command must complete without a violation. Both negative commands must report an invariant counterexample: accepting mismatched reconstruction permits wrong execution, and premature release removes input while an obligation remains. A parser, compiler, or checker error does not satisfy either negative check.

`checkpoint/acceptanceBinding.qnt` checks atomic acceptance bindings, distinct identical calls, checkpoint retention, and recovery. The finite model explores two invocations in one atom and another invocation in a second atom. Split commits, dropped bindings, and swapped ownership are negative cases.

The shared work model has a separate verification surface:

```sh
quint test packages/core/quint/workLifecycle.qnt
work_model="$PWD/packages/core/quint/workLifecycle.qnt"
work_checks=$(mktemp -d /tmp/tardigrade-work.XXXXXX)
cd "$work_checks"
quint verify "$work_model" --backend tlc --invariant invariant --temporal attemptsEnd
quint verify "$work_model" --backend tlc --step stepEarlyRelease --invariant inputRetained
quint verify "$work_model" --backend tlc --step stepTimeoutAcknowledgesStop --invariant quiescenceSound
quint verify "$work_model" --backend tlc --step stepFailedCleanupDischarges --invariant cleanupDischargeSound
```

The three negative checks must produce invariant counterexamples. Timeout cannot supply a stop acknowledgement, and failed cleanup cannot discharge the obligation or release its input.

The implemented deadline contract has a separate verification surface:

```sh
quint test packages/core/quint/attemptDeadline.qnt
deadline_model="$PWD/packages/core/quint/attemptDeadline.qnt"
deadline_checks=$(mktemp -d /tmp/tardigrade-deadline.XXXXXX)
cd "$deadline_checks"
quint verify "$deadline_model" --backend tlc --invariant invariant --temporal attemptsEnd
quint verify "$deadline_model" --backend tlc --step stepEarlyRelease --invariant retained
quint verify "$deadline_model" --backend tlc --step stepTimeoutDischargesCleanup --invariant cleanupDischargeSound
quint verify "$deadline_model" --backend tlc --step stepDropsLateHandle --invariant handleRetained
```

The three negative checks must produce invariant counterexamples.

The stream deadline contract has a separate verification surface:

```sh
quint test packages/core/quint/streamDeadline.qnt
stream_model="$PWD/packages/core/quint/streamDeadline.qnt"
stream_checks=$(mktemp -d /tmp/tardigrade-stream.XXXXXX)
cd "$stream_checks"
quint verify "$stream_model" --backend tlc --invariant invariant --temporal streamsEnd
quint verify "$stream_model" --backend tlc --step stepTimeoutCompletes --invariant successRequiresEnd
quint verify "$stream_model" --backend tlc --step stepMissesReset --invariant deadlineReset
```

Both negative checks must produce invariant counterexamples.
