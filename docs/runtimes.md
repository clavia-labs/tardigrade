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
| `Sessions` | List the addresses being served and read one session's log |
| `Self` | Expose the current session address |

The harness turn path directly requires `EventLog`, `Writer`, `Wake`, `Router`, and `Self`. Delegation adds `Sessions`, which it reads to walk a delivery's ancestry. A complete runtime binds the full port set so modules can use the remaining capabilities without changing deployment wiring.

## In-Memory Runtime

`flamecast-core/runtime-in-memory` completely binds every runtime port for process-local sessions.

```ts
const runtime = InMemoryRuntime({
  keyOf,
  session: "user-42",
  seed: recorded,
  sessions: {
    "agent:lead": serve(lead),
    "worker/*": (address) => serve(workerFor(address))
  },
  services: Context.make(Sandbox, inProcessSandbox())
})
```

It uses arrays, maps, and a semaphore. Agents, routing, wake tracking, spill storage, replay, and concurrent sessions all run without external services. State lives for the lifetime of the layer and disappears with the process.

## The Session Registry

Serving many sessions is address resolution, so it belongs to the runtime that owns addresses, storage, and leases. `sessions` says who answers where: an exact key names one address, and a `prefix/*` key or a bare `*` names a family and holds a factory that receives the address. A store and a writer lease appear on first delivery, and a session exists once its log holds something, so an address a caller invents costs nothing until it records one.

A registry value is a plain function from an event to a terminal event. `serve` in the harness builds one from an agent, and an application whose sessions are machines rather than agents registers its own. `services` binds what those sessions need beyond the runtime's own ports, for a served session and for a caller alike, and a session that reaches for a service the runtime was not given fails to compile.

Both halves take one argument, so the key's shape is what says which a value is: the type of an exact key is what serves that address, and the type of a pattern key is a function of the address. Getting them the wrong way round would call a factory with an event or a serve with an address, and both die on delivery, so the registry is checked key by key rather than as a union.

## Planned Bindings

`runtime-cf` and `runtime-celld` are design targets and have no package in the repository.

- `runtime-cf` is the durable reference target. It can map a session to a Durable Object, wakes to alarms, spill to R2, and routing to worker calls, with `wrangler` serving the local development loop. On that platform an address already names a durable object, so the platform owns resolution, storage, and the lease, and the registry becomes a namespace binding.
- A celld binding can map each session to a self-hosted cell with a local database and distributed lease.

Durable read APIs, session listing, and cross-process replay depend on one of those bindings being implemented.

## Router Semantics

`Router.call` waits for a terminal event and returns it to the caller, which is what an awaited delegation needs. `Router.deliver` is the asynchronous door: the receiving session appends the event and settles independently, and a later reply can target the caller through `replyTo`.

A call cycle would deadlock on writer leases, so [`serve`](orchestration.md#serving-an-agent) refuses cycles and bounds depth from the derived origin chain before running the target. A registry value that is not built by `serve` owes its own guard.

## Implementing a Runtime

Use the core conformance utilities for event log and machine guarantees. Preserve append order, dedup behavior, writer exclusion, and deterministic reads. Keep platform vocabulary inside the binding.

[Architecture](architecture.md) shows where runtime ports enter turn execution.
