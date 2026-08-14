# Runtimes

A runtime binds platform services. Agent modules and machines stay unchanged across runtime implementations.

## Port Contract

| Port | Guarantee |
| --- | --- |
| `EventLog` | Append, read, read from a watermark, and report the head offset |
| `Writer` | Serialize work for one session |
| `Wake` | Track the nearest owed wake time |
| `Placement` | Resolve an address to a host |
| `Spill` | Store and retrieve large byte payloads |
| `Sink` | Accept optional outbound observability records |
| `Router` | Deliver asynchronous events or perform synchronous calls between sessions |
| `Self` | Expose the current session address |

The harness turn path directly requires `EventLog`, `Writer`, `Wake`, `Router`, and `Self`. A complete runtime binds the full port set so modules can use the remaining capabilities without changing deployment wiring.

## In-Memory Runtime

`flamecast-core/runtime-in-memory` completely binds every runtime port for process-local sessions.

```ts
const runtime = InMemoryRuntime({
  keyOf,
  session: "user-42",
  seed: recorded,
  route: (address, event) => routeInProcess(address, event)
})
```

It uses arrays, maps, a semaphore, and an optional route function. Agents, routing, wake tracking, spill storage, replay, and concurrent sessions all run without external services. State lives for the lifetime of the layer and disappears with the process.

## Planned Bindings

`runtime-cf` and `runtime-celld` are design targets and have no package in the repository.

- `runtime-cf` is the durable reference target. It can map a session to a Durable Object, wakes to alarms, spill to R2, and routing to worker calls, with `wrangler` serving the local development loop. On that platform the address itself names the session's host, so it replaces the in-process [session host](orchestration.md#session-host) wholesale.
- A celld binding can map each session to a self-hosted cell with a local database and distributed lease.

Durable read APIs, session listing, and cross-process replay depend on one of those bindings being implemented.

## Router Semantics

`Router.call` waits for a terminal event and returns it to the caller, which is what an awaited delegation needs. `Router.deliver` is the asynchronous door: the receiving session appends the event and settles independently, and a later reply can target the caller through `replyTo`.

A call cycle would deadlock on writer leases, so the harness [host](orchestration.md#session-host) refuses cycles and bounds depth before running the target. A runtime without the host owes its own guard or its route functions must stay acyclic.

## Implementing a Runtime

Use the core conformance utilities for event log and machine guarantees. Preserve append order, dedup behavior, writer exclusion, and deterministic reads. Keep platform vocabulary inside the binding.

[Architecture](architecture.md) shows where runtime ports enter turn execution.
