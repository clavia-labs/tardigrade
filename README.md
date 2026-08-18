# Tardigrade

Tardigrade is an agent harness built with the log as its core, inspired by event sourcing and React. State at any point is a pure function of the log, and the harness is a set of transitions derived from it.

$$\{\mathrm{transitions}\} = f(\mathrm{log})$$

## Quickstart

```ts
import { createAgent } from "@flamecast/agent/main"

const agent = createAgent({
  packages: [invoices], // e.g. invoices.lookup({orderId})
  infer: async (trajectory) => nextAction(trajectory) // one inference, one action; platform/model binds a real provider
})

const reply = await agent.run("Find the invoice for order 4182.")
```

Under the hood a capability is a reactor: a pure function from the log to keyed work. This is the whole tools capability.

```ts
// One transition per unanswered call. A crashed act never records its key;
// the next settle derives the same transition and retries: durability, no retry code.
const tools: Reactor = (events) =>
  unansweredCalls(events).map((call) =>
    transition({
      key: call.callId,
      input: call,
      act: (call) => Effect.promise(async () => [{ type: "ToolReturned", callId: call.callId, result: await run(call) }])
    })
  )
```

`packages/agent` composes the agent from six of these: inference, tools, budget, reply, compaction, spawn.

## Concepts

### Events

An event is a fact, recorded once and never edited. Everything else is derived from the set of them.

```ts
// An Event is an open record. Concrete events narrow it.
type Event = { type: string } & Record<string, unknown>

type MessageReceived = { type: "MessageReceived"; id: string; text: string; at: number }
type ToolCalled = { type: "ToolCalled"; callId: string; name: string; arguments: unknown }
type ToolReturned = { type: "ToolReturned"; callId: string; result: unknown }
type TurnCompleted = { type: "TurnCompleted"; output: string }
```

### Projections

A projection is a pure function from the event log to a value.

```ts
type Projection<T> = (events: ReadonlyArray<Event>) => T

// done: the turn has reached its terminal.
const done: Projection<boolean> = (events) => events.some((e) => e.type === "TurnCompleted")
```

### Transitions and reactors

```ts
// One keyed unit of work: state in, events out. A retried fire is the same work, absorbed by its key.
interface Transition<T> {
  readonly key: string
  readonly input: T
  readonly act: (input: T) => Effect.Effect<ReadonlyArray<Event>, never, EventLog | R>
}

// Derives the transitions the log enables. The runtime fires each key the log does not record.
type Reactor = (events: ReadonlyArray<Event>) => ReadonlyArray<Transition>
```

An actor is a set of reactors over one log, plus the key derivation that decides commitment.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/reconciler-loop-dark.svg">
  <img alt="The reconciler loop: the log feeds reactors, reactors derive transitions, unrecorded keys fire, events land keyed record last" src="docs/assets/reconciler-loop-light.svg">
</picture>

## Layout

```
packages/
  core/      contracts: Event, EventLog, KeyFragment, Transition, Reactor, Router
  code/      durable code execution
  agent/     the agent as reactors, and createAgent
  host/      the reference in-memory binding
platform/
  model/     the Infer binding over TanStack AI
  bun/       the durable host binding: SQLite through @effect/sql
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and run `bun run gate` before finishing a change.
