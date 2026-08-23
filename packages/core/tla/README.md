# Formal verification

The specifications describe the runtime and communication contracts independently of a host implementation. Thread and address values remain abstract unless a model configuration supplies a finite example.

`communication` contains contracts between endpoints. `runtime` contains contracts for one actor thread and the driver that serves many threads.

## Checks

| Module | Contract | Passing configurations | Counterexample configurations |
| --- | --- | --- | --- |
| `communication/Delivery` | Spawn, await, settlement, and deadlock | `Delivery.cfg`, `DeliveryLive.cfg` | `DeliveryDeadlock.cfg` |
| `communication/Link` | Directory resolution, target commit, and retry absorption | `Link.cfg`, `LinkLive.cfg` | `LinkMisroute.cfg`, `LinkStale.cfg` |
| `communication/Reply` | Terminal and budget reports through the reversed accepted link | `Reply.cfg`, `ReplyLive.cfg` | `ReplyHint.cfg` |
| `runtime/Component` | A call remains routable through the view that offered it | `Component.cfg` | `ComponentCurrent.cfg` |
| `runtime/Driver` | Wake accounting, service, isolation, and bounded failure | `Driver.cfg`, `DriverLive.cfg`, `DriverIsolate.cfg`, `DriverPoisoned.cfg` | `DriverDrop.cfg` |
| `runtime/Guard` | Terminal outcome remains singular across attempts | `Guard.cfg` | `GuardRace.cfg` |
| `runtime/Projection` | Prefix interpretation remains faithful | `Projection.cfg` | `ProjectionView.cfg` |
| `runtime/Reconcile` | Derived keyed work commits, blocks, or settles | `Reconcile.cfg` | None |
| `runtime/Replay` | Recorded answers remain bound to their questions | `Replay.cfg` | `ReplayTrust.cfg` |
| `runtime/Thread` | Atomic creation, immutable lineage, and retry absorption | `Thread.cfg`, `ThreadLive.cfg` | `ThreadSplit.cfg`, `ThreadDepth.cfg`, `ThreadConflict.cfg` |
| `runtime/Totality` | A rulebook covers every live event without swallowing work | `Totality.cfg` | `TotalityVoid.cfg` |

A counterexample configuration is successful when TLC violates the property named by the suite manifest. A parser error, deadlock report, or unrelated violation fails the suite.

## Run the suite

Install Java and download the official `tla2tools.jar`, then expose its path and run the repository command:

```sh
TLA2TOOLS_JAR=/absolute/path/to/tla2tools.jar bun run tla
```

Set `TLA_JAVA` when `java` is outside `PATH`. Set `TLA_WORKERS` to choose the TLC worker count. The default is one worker. Set `TLA_TIMEOUT_MILLIS` to change the per-configuration limit. The default is 120000 milliseconds. Pass module names to run a subset:

```sh
TLA2TOOLS_JAR=/absolute/path/to/tla2tools.jar bun run tla Thread Reply
```

The runner writes TLC state data to a temporary directory and removes it after the suite. TLC state data under `packages/core/tla/states` is ignored because it is generated output.
