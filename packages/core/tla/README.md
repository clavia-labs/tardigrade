# Formal verification

The specifications describe core and host contracts. Thread and address values remain abstract unless a model configuration supplies a finite example.

Core folders follow `src`: `actor` covers coordinates and instance isolation, `interaction` covers invocation lifecycles, `transport` covers delivery, `component` covers behavior composition, `projection` covers event interpretation, `log` supplies log operators, and `runtime` covers execution. Host allocation, thread initialization, drivers, and commit notifications live in `packages/host/tla`. Cloudflare execution and directory protocols live in `platform/cloudflare/tla`.

## Identity contract

`packages/host/tla/Identity.tla` connects the host allocator in `packages/host/src/allocation.ts` and `allocation-sql.ts` to core invocation coordinates in `packages/core/src/interaction/invocation.ts`. An allocation claim reads the durable directory, recovers an existing scoped assignment, or reserves an unused candidate atomically. Interleaved claims represent concurrent requests. Retrying after loss of caller state reads the same durable assignment. Tuples represent the injective JSON encodings used by the implementation.

The finite configuration includes two roots in one instance, children with the same local name under different parents, a grandchild, another instance, and another actor definition. It checks thread separation, parent separation, stable returned references, invocation separation across methods and epochs, and caller-scoped idempotency keys. Counterexamples omit parent scope, bypass collision checks, replace retry assignments, omit invocation targets, or omit caller identity.

The contract assumes unique actor-instance coordinates, locally unique invocation tuples, and atomic durable claims. Host storage must preserve these assumptions. The liveness configuration assumes enough candidate IDs and fair successful claims; bounded random allocation can instead report exhaustion. TLC exhaustively checks the configured finite space. It does not prove the TypeScript implementation or unbounded trees.

## Checks

| Module | Contract | Passing configurations | Counterexample configurations |
| --- | --- | --- | --- |
| `host/Identity` | Scoped thread allocation, tagged names and keys, retry stability, and invocation coordinate separation | `Identity.cfg`, `IdentityKey.cfg`, `IdentityLive.cfg` | `IdentityParent.cfg`, `IdentityCollision.cfg`, `IdentityRetry.cfg`, `IdentityTarget.cfg`, `IdentityCaller.cfg` |
| `interaction/Delivery` | Spawn, await, independently served methods, settlement, and deadlock | `Delivery.cfg`, `DeliveryLive.cfg` | `DeliveryDeadlock.cfg` |
| `transport/Link` | Directory resolution, target commit, and retry absorption | `Link.cfg`, `LinkLive.cfg` | `LinkMisroute.cfg`, `LinkStale.cfg` |
| `interaction/Method` | Durable method futures from request through dispatch, acceptance, terminal resolution, and reversed-link response | `Method.cfg`, `MethodAlarm.cfg`, `MethodLive.cfg` | `MethodHint.cfg`, `MethodNoDeadline.cfg` |
| `component/Component` | A call remains routable through the view that offered it | `Component.cfg` | `ComponentCurrent.cfg` |
| `interaction/Cancellation` | Requests keyed by actor invocation identity absorb retries, isolate method epochs, block new effects, signal admitted effects, close calls, cancel linked child invocations, and record each method terminal after its cleanup | `Cancellation.cfg` | `CancellationIdentity.cfg`, `CancellationEffectLeak.cfg`, `CancellationNoSignal.cfg`, `CancellationOpenCall.cfg`, `CancellationChild.cfg`, `CancellationNoSettle.cfg`, `CancellationUnreachableChild.cfg` |
| `interaction/CancellationDeadline` | A cancellation deadline bounds parent settlement when a child does not acknowledge | `CancellationDeadline.cfg` | None |
| `interaction/CancellationParallel` | Independent cleanup obligations can start before their peers finish | `CancellationParallel.cfg` | `CancellationSerial.cfg` |
| `interaction/InvocationPublication` | Child ownership becomes durable before external publication | `InvocationPublication.cfg` | `InvocationPublicationEarly.cfg` |
| `interaction/InvocationEpoch` | Each logical method call has at most one active execution owner, and a resumed epoch preserves its parent and deadline | `InvocationEpoch.cfg` | `InvocationEpochOverlap.cfg`, `InvocationEpochDetached.cfg` |
| `interaction/InvocationDeadline` | A child deadline remains bounded by its parent deadline | `InvocationDeadline.cfg` | `InvocationDeadlineLocal.cfg` |
| `projection/IncrementalProjection` | Incremental folds equal complete prefix replay, snapshots preserve that equality, and stale derivations cannot commit | `IncrementalProjection.cfg` | `IncrementalProjectionSkip.cfg`, `IncrementalProjectionStale.cfg`, `IncrementalProjectionSnapshot.cfg` |
| `runtime/Coherence` | Sibling transitions resolve intent suppression before external effects begin | `Coherence.cfg` | `CoherenceBatch.cfg`, `CoherenceRevalidate.cfg` |
| `host/CommitTail` | A durable head wakes a cursor after the read and subscribe race | `CommitTail.cfg` | `CommitTailDrop.cfg` |
| `interaction/Child` | Parent-owned child identity, delivery ordering, initialization, and recovery | `Child.cfg`, `ChildLive.cfg` | `ChildEarly.cfg`, `ChildRecompute.cfg` |
| `actor/ActorInstance` | Instance authorization, child ownership, routing, listing, key isolation, revocation, and request settlement | `ActorInstance.cfg`, `ActorInstanceLive.cfg` | `ActorInstanceAuthority.cfg`, `ActorInstanceChildEscape.cfg`, `ActorInstanceObjectAlias.cfg`, `ActorInstanceGlobalList.cfg`, `ActorInstanceSharedKey.cfg` |
| `host/ConcurrentDriver` | Bounded parallel settlement, keyed commits, and parked fiber release | `ConcurrentDriver.cfg`, `ConcurrentDriverLive.cfg` | `ConcurrentDriverUnbounded.cfg`, `ConcurrentDriverParkLeak.cfg` |
| `host/Driver` | Wake accounting, service, isolation, and bounded failure | `Driver.cfg`, `DriverLive.cfg`, `DriverIsolate.cfg`, `DriverPoisoned.cfg` | `DriverDrop.cfg`, `DriverAlarmRace.cfg` |
| `runtime/Execution` | Mixed package completion and parked fiber release | `Execution.cfg` | `ExecutionReadyLeak.cfg` |
| `runtime/Guard` | Terminal outcome remains singular across attempts | `Guard.cfg` | `GuardRace.cfg` |
| `component/ModelPolicy` | Coordinate authority, complete host defaults, recursive attenuation, and selection | `ModelPolicy.cfg` | `ModelPolicyWiden.cfg` |
| `projection/Projection` | Prefix interpretation remains faithful | `Projection.cfg` | `ProjectionView.cfg` |
| `projection/ProjectionAlgebra` | A product projection factors behavior, composes homomorphically, and represents the bounded future-equivalence quotient | `ProjectionAlgebra.cfg` | `ProjectionAlgebraCurrent.cfg`, `ProjectionAlgebraBalance.cfg` |
| `projection/ProjectionVersion` | Fine projections safely coarsen across versions, while coarse snapshots cannot reconstruct distinctions required by a finer policy | `ProjectionVersion.cfg` | `ProjectionVersionGuess.cfg`, `ProjectionVersionRefine.cfg` |
| `runtime/Reconcile` | Derived keyed work commits, blocks, or settles | `Reconcile.cfg` | None |
| `runtime/Replay` | Recorded answers remain bound to their questions | `Replay.cfg` | `ReplayTrust.cfg` |
| `host/Thread` | Atomic creation, immutable lineage, and retry absorption | `Thread.cfg`, `ThreadLive.cfg` | `ThreadSplit.cfg`, `ThreadDepth.cfg`, `ThreadConflict.cfg` |
| `runtime/Totality` | A rulebook covers every live event without swallowing work | `Totality.cfg` | `TotalityVoid.cfg` |
| `cloudflare/ThreadCreation` | Actor directory reservation, child acceptance, publication, and retry completion | `ThreadCreation.cfg`, `ThreadCreationLive.cfg` | `ThreadCreationCurrent.cfg` |
| `cloudflare/DurableExecution` | Durable wake coverage for owed execution | `DurableExecution.cfg` | `DurableExecutionNoTurn.cfg`, `DurableExecutionNoWatchdog.cfg` |

A counterexample configuration is successful when TLC violates the property named by the suite manifest. A parser error, deadlock report, or unrelated violation fails the suite.

## Run the suite

Install Java and download the official `tla2tools.jar`, then expose its path and run the repository command:

```sh
TLA2TOOLS_JAR=/absolute/path/to/tla2tools.jar bun run tla
```

Set `TLA_JAVA` when `java` is outside `PATH`. Set `TLA_WORKERS` to choose the TLC worker count. The default is one worker. Set `TLA_TIMEOUT_MILLIS` to change the per-configuration limit. The default is 120000 milliseconds. Pass module names to run a subset:

```sh
TLA2TOOLS_JAR=/absolute/path/to/tla2tools.jar bun run tla Thread Method
```

The runner writes TLC state data to a temporary directory and removes it after the suite. TLC state data under `packages/core/tla/states` is ignored because it is generated output.
