# flamework

flamework is a library for durable agents: the event log is the only state, reactors derive work from it, and a reconciler fires what the log does not yet record.

The design in one pass: an actor is the single writer of one log. A reactor is a pure function from the log to keyed transitions, `{key, input, act}`. The runtime fires a transition only when no recorded event derives its key, so a crash, a retry, or a redelivery changes nothing. Replay is re-derivation. Recovery is re-settling.

## Layout

| Directory | Holds |
| --- | --- |
| `packages/core` | The contracts: Envelope, EventLog and its six guarantees, KeyFragment, Transition, Reactor, the reconciler, Router |
| `packages/code` | Durable code execution: recorded package calls, parks as BlockedOn evidence, replay drift guard, the contract gate |
| `packages/agent` | The agent as reactors: inference, tools, budget, reply, compaction, and the Infer port |
| `packages/host` | The reference in-memory binding: the executable statement every platform must match |
| `platform/model` | The Infer binding over TanStack AI: Bedrock Converse and OpenAI-compatible wires |
| `platform/bun` | The durable host binding: SQLite through @effect/sql, with recovery from a surviving log |

The line between the trees is a dependency rule: a package depends on effect and on other packages, and on nothing else. A platform binds one port to the world and owns its own dependencies. `platform/README.md` states the rule in full.

## Quick start

The worked example below is `platform/bun/src/host.test.ts`, shortened: one reactor that owes one keyed `Done` per received message, run on the durable host.

```ts
import { Effect } from "effect"
import { transition, type Actor, type Reactor } from "@flamecast/core/actor"
import { createBunHost } from "@flamecast/bun/host"

const keyOf = (e: { type: string; id?: string }) => (e.type === "Done" ? `dn:${e.id}` : undefined)

const echoReactor: Reactor = (events) =>
  events
    .filter((e) => e.type === "MessageReceived")
    .map((e) => {
      const id = String((e as { id?: unknown }).id)
      return transition({
        key: `dn:${id}`,
        input: id,
        act: (input: string) => Effect.succeed([{ type: "Done", id: input, at: 1 }])
      })
    })

const echo: Actor = { reactors: [echoReactor], keyOf }

const host = await createBunHost({ path: "agents.sqlite", actorFor: (lane) => (lane === "echo" ? echo : undefined), keyOf })
await host.deliver("bun:echo", { type: "MessageReceived", id: "m1", text: "go", at: 1 })
await host.drive()
```

Kill the process and start again: `host.recover()` re-derives the owed work from the surviving log, and a transition that already committed absorbs instead of firing twice.

## Guarantees

A store that binds the log port owes six guarantees, stated in `packages/core/src/event-log.ts`: append only, total order per log, one writer, atomic batches, dedup by key, and the ordered tail from a watermark. The reconciler's properties are model checked in `packages/core/tla` (Reconcile, Projection, Replay, Driver, Delivery). Every delivered cross-lane event names its occurrence through a key fragment, and both hosts refuse an unkeyed traveler.

## Status

The packages are private workspace packages, consumed in-repo. The docs/ tree predates this design and describes the removed harness and codemode surfaces; it is queued for a rewrite. `platform/model` carries the proven driver; journaled backoff, model-reported limits, provider continuations, and spend reservation are the next behaviors to land on it.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and run `bun run gate` before finishing a change.
