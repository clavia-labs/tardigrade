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
| Commit and publication | Prepared state remains invisible until commit, [runtimeCheckpoint](checkpoint/runtimeCheckpoint.qnt), `visibleEquivalent`; acceptance survives reopening, [proposalCheckpoint](checkpoint/proposalCheckpoint.qnt), `recoveryMatchesRequest` | Atomic journal/checkpoint writes, persistence failure forces reopening, reconstructed proposals agree |
| Effect recovery | Retry identity and deferred ownership survive replay, [effectRecovery](checkpoint/effectRecovery.qnt), `retryIdentity`, `localRestartOnly` | Durable lifecycle records, preserved refs and handles, local ownership distinguishes restart from remote observation |
| Promise admission | Result follows successful effect settlement; correlated callbacks share its batch, [promiseDelivery](checkpoint/promiseDelivery.qnt), `settlementFirst`, `batchExactlyOnce` | Serialized admission, atomic callback batch, retry early delivery, suppress already terminal groups independently |
| Shared lifecycle | Acceptance, commit/publication, graph recovery and producer ownership coexist, [lifecycleCheckpoint](checkpoint/lifecycleCheckpoint.qnt), `invariant` | Complete durable roots, deterministic reconstruction, atomic writes and callback batches; finite single-effect abstraction |
| Input representation | Acceptance observation ignores payload and inline/digest choice, [effectInput](effectInput.qnt), `observe`; execution checks reconstructed act/input, [inputLifecycle](checkpoint/inputLifecycle.qnt), `verifiedExecution` | Digest equality identifies equal canonical inputs, reconstruction has all required domain state and configuration |
| Input lifetime | Live execution and nonterminal obligations retain full input; crashes require rehydration, [inputLifecycle](checkpoint/inputLifecycle.qnt), `inputRetained` | Verify before dispatch/restart and before input-dependent preparation; cancellation cleanup requires an additional lifetime obligation |
| Cancellation | Completion and cancellation are exclusive; owned forwarding is isolated, [cancellation](cancellation.qnt), `terminalExclusive`, `cancellationIsolation` | Durable ownership, atomic local terminal decisions; cross-log ownership requires reconciliation; remote abort acknowledgement is external |
| Actor stop | Stale proposals are fenced and pending tools drain, [actorCancellation](actorCancellation.qnt), `acceptanceFenced`, `settlementSound` | Accepted work is assigned to the turn, callbacks and tool obligations survive crashes |
| Terminal delivery | Terminal callbacks occur at most once; unrelated result groups survive suppression, [terminalDelivery](terminalDelivery.qnt), `callbackAtMostOnce`, `validBatchPreserved` | Terminal decision and domain callbacks share a commit, each result group has independent ownership |
| Thread invocation | Reply obligation survives receiver acknowledgement, [messageReply](invocation/messageReply.qnt), `obligationConserved`, `replyRecoverable`; replay avoids duplicate logical execution, [invocationReplay](../../platform/quint/invocationReplay.qnt), `oneLogicalExecution` | Stable invocation key, receiver deduplication, durable dependency and reply; eventual transport and recovery for progress |
| Host wake | Pending work remains covered, [watchdog](../../platform/quint/watchdog.qnt), `wakeCoverage` | Atomic admission/wake, replacement wake before detached work, interrupted delivery remains retryable; eventual delivery and a crash-free suffix for progress |
| Recovery limits | Persisted accounting bounds attempts and eventually stops, [recoveryBudget](../../platform/quint/recoveryBudget.qnt), `boundedAttempts`, `eventualStop` | Charge before execution, durable counters and deadlines, fair alarm delivery and attempt timers |
| Deferred host work | Local fibre exit is accounted for; remote work parks with a stable deadline, [promiseLifecycle](../../platform/quint/promiseLifecycle.qnt), `fibreExitAccounted`, `noRemoteBurn`, `firstDecisionWins` | Durable result source and deadline, local supervision, fair recovery and result delivery; timeout supplies no remote abort acknowledgement |

The scheduling models have different progress contracts: watchdog settlement assumes terminating effects; bounded recovery permits explicit failure after a budget or deadline. Input safety composes with either outcome. An alarm guarantees an opportunity to recover work; executing remote work exactly once additionally requires a replay-safe executor or receiver deduplication.

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
