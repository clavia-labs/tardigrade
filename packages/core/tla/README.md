# Formal verification

The specifications describe the runtime and communication contracts independently of a host implementation. Thread and address values remain abstract unless a model configuration supplies a finite example.

`communication` contains contracts between endpoints. `runtime` contains contracts for one actor thread and the driver that serves many threads.

## Checks

| Module | Contract | Passing configurations | Counterexample configurations |
| --- | --- | --- | --- |
| `communication/Delivery` | Spawn, await, independently served methods, settlement, and deadlock | `Delivery.cfg`, `DeliveryLive.cfg` | `DeliveryDeadlock.cfg` |
| `communication/Link` | Directory resolution, target commit, and retry absorption | `Link.cfg`, `LinkLive.cfg` | `LinkMisroute.cfg`, `LinkStale.cfg` |
| `communication/Method` | Durable method futures from request through dispatch, acceptance, terminal resolution, and reversed-link response | `Method.cfg`, `MethodLive.cfg` | `MethodHint.cfg` |
| `runtime/Component` | A call remains routable through the view that offered it | `Component.cfg` | `ComponentCurrent.cfg` |
| `runtime/Cancellation` | Requests keyed by actor invocation identity absorb retries, isolate method epochs, block new effects, signal admitted effects, close calls, cancel linked child invocations, and record each method terminal after its cleanup | `Cancellation.cfg` | `CancellationIdentity.cfg`, `CancellationEffectLeak.cfg`, `CancellationNoSignal.cfg`, `CancellationOpenCall.cfg`, `CancellationChild.cfg`, `CancellationNoSettle.cfg` |
| `runtime/InvocationPublication` | Child ownership becomes durable before external publication | `InvocationPublication.cfg` | `InvocationPublicationEarly.cfg` |
| `runtime/InvocationEpoch` | Each logical method call has at most one active execution owner | `InvocationEpoch.cfg` | `InvocationEpochOverlap.cfg` |
| `runtime/InvocationDeadline` | A child deadline remains bounded by its parent deadline | `InvocationDeadline.cfg` | `InvocationDeadlineLocal.cfg` |
| `runtime/Coherence` | Sibling transitions resolve intent suppression before external effects begin | `Coherence.cfg` | `CoherenceBatch.cfg`, `CoherenceRevalidate.cfg` |
| `runtime/CommitTail` | A durable head wakes a cursor after the read and subscribe race | `CommitTail.cfg` | `CommitTailDrop.cfg` |
| `runtime/Child` | Parent-owned child identity, delivery ordering, initialization, and recovery | `Child.cfg`, `ChildLive.cfg` | `ChildEarly.cfg`, `ChildRecompute.cfg` |
| `runtime/ActorInstance` | Instance authorization, child ownership, routing, listing, key isolation, revocation, and request settlement | `ActorInstance.cfg`, `ActorInstanceLive.cfg` | `ActorInstanceAuthority.cfg`, `ActorInstanceChildEscape.cfg`, `ActorInstanceObjectAlias.cfg`, `ActorInstanceGlobalList.cfg`, `ActorInstanceSharedKey.cfg` |
| `runtime/ConcurrentDriver` | Bounded parallel settlement, keyed commits, and parked fiber release | `ConcurrentDriver.cfg`, `ConcurrentDriverLive.cfg` | `ConcurrentDriverUnbounded.cfg`, `ConcurrentDriverParkLeak.cfg` |
| `runtime/Driver` | Wake accounting, service, isolation, and bounded failure | `Driver.cfg`, `DriverLive.cfg`, `DriverIsolate.cfg`, `DriverPoisoned.cfg` | `DriverDrop.cfg` |
| `runtime/Execution` | Mixed package completion and parked fiber release | `Execution.cfg` | `ExecutionReadyLeak.cfg` |
| `runtime/Guard` | Terminal outcome remains singular across attempts | `Guard.cfg` | `GuardRace.cfg` |
| `runtime/ModelPolicy` | Coordinate authority, complete host defaults, recursive attenuation, and selection | `ModelPolicy.cfg` | `ModelPolicyWiden.cfg` |
| `runtime/Projection` | Prefix interpretation remains faithful | `Projection.cfg` | `ProjectionView.cfg` |
| `runtime/Reconcile` | Derived keyed work commits, blocks, or settles | `Reconcile.cfg` | None |
| `runtime/Replay` | Recorded answers remain bound to their questions | `Replay.cfg` | `ReplayTrust.cfg` |
| `runtime/Thread` | Atomic creation, immutable lineage, and retry absorption | `Thread.cfg`, `ThreadLive.cfg` | `ThreadSplit.cfg`, `ThreadDepth.cfg`, `ThreadConflict.cfg` |
| `runtime/Totality` | A rulebook covers every live event without swallowing work | `Totality.cfg` | `TotalityVoid.cfg` |
| `cloudflare/ThreadCreation` | Actor directory reservation, child acceptance, publication, and retry completion | `ThreadCreation.cfg`, `ThreadCreationLive.cfg` | `ThreadCreationCurrent.cfg` |

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
