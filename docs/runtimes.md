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

It uses arrays, maps, a semaphore, and an optional route function. Agents, routing, wake tracking,
spill storage, replay, and concurrent sessions all run without external services. State lives for
the lifetime of the layer and disappears with the process.

## Planned Bindings

`runtime-cf` and `runtime-celld` are design targets and have no package in the repository.

- A Cloudflare binding can map sessions to Durable Objects, alarms, R2, and worker routing.
- A celld binding can map each session to a self-hosted cell with a local database and distributed lease.

Durable read APIs, session listing, and cross-process replay depend on one of those bindings being implemented.

## Router Semantics

`Router.call` waits for a terminal event and is suited to quick acyclic sub-calls. Cycles can deadlock when sessions each hold their writer lock.

`Router.deliver` is the asynchronous door. The receiving session appends the event and settles independently. A later reply can target the caller through `replyTo`.

## Implementing a Runtime

Use the core conformance utilities for event log and machine guarantees. Preserve append order, dedup behavior, writer exclusion, and deterministic reads. Keep platform vocabulary inside the binding.

[Architecture](architecture.md) shows where runtime ports enter turn execution.
