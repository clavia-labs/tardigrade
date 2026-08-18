# Tardigrade

Tardigrade is an agent harness built with the log as its core, inspired by event sourcing and React. State at any point is a pure function of the log, and the harness is a set of transitions derived from it.

$$\{\mathrm{transitions}\} = f(\mathrm{log})$$

## Quickstart: an agent

An agent is three reactors over one log. Start with a projection: which calls have no result yet? An absence is state too, and only a function over the whole set can see one.

```ts
const unansweredCalls: Projection<ReadonlyArray<ToolCalled>> = (events) =>
  events
    .filter((e) => e.type === "ToolCalled")
    .filter((c) => !events.some((e) => e.type === "ToolReturned" && e.callId === c.callId))

// tools: one transition per unanswered call.
const tools: Reactor = (events) =>
  unansweredCalls(events).map((call) =>
    transition({
      key: call.callId,
      input: call,
      act: (call) => Effect.promise(async () => [{ type: "ToolReturned", callId: call.callId, result: await toolbox[call.name](call.arguments) }])
    })
  )

// infer: enabled when every call is answered and no terminal yet. A crashed
// attempt never records its key, so the next settle retries it: durability, no retry code.
const infer: Reactor = (events) => {
  if (done(events) || unansweredCalls(events).length > 0) return []
  const attempt = events.filter((e) => e.type === "ToolReturned").length
  return [transition({ key: `llm/${attempt}`, input: events, act: runLlm })]
}

const agent: Actor = { reactors: [infer, tools, compaction], keyOf }
```

Every reactor on this page has the same anatomy: a projection derives the input, the reactor keys it, the act does the work. Adding a capability is adding a reactor to the list.

<img alt="The agent as the loop: one log, three reactors deriving from it, fires landing back in it" src="docs/assets/agent-loop.svg">

`packages/agent` ships this agent grown up: inference with died-attempt marks and a give-up guard, tool dispatch through durable code execution, budgets, replies, and compaction, each one a reactor.

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

A projection is that derivation, named: a pure function from the event set to a value.

```ts
type Projection<T> = (events: ReadonlyArray<Event>) => T

// done: the turn has reached its terminal.
const done: Projection<boolean> = (events) => events.some((e) => e.type === "TurnCompleted")
```

There is no cache and no invalidation: the log is the source, so a projection can never be stale. This is `state = f(log)`, the way React's derived values are `f(state)`. If a piece of logic appends nothing, it is a projection, never a reactor; reactors exist only for work that must land in the log.

### Transitions and reactors

If you know React's `UI = f(state)`, you know the shape here: `transitions = f(log)`.

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

<img alt="The reconciler loop: the log feeds reactors, reactors derive transitions, unrecorded keys fire, events land keyed record last" src="docs/assets/reconciler-loop.svg">

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

The line between the trees is a dependency rule: a package depends on effect and on other packages, and on nothing else. A platform binds one port to the world and owns its own dependencies. `platform/README.md` states the rule in full.

## Guarantees

A store that binds the log port owes six guarantees, stated in `packages/core/src/event-log.ts`: append only, total order per log, one writer, atomic batches, dedup by key, and the ordered tail from a watermark. The reconciler's properties are model checked in `packages/core/tla` (Reconcile, Projection, Replay, Driver, Delivery). Every delivered cross-lane event names its occurrence through a key fragment, and both hosts refuse an unkeyed traveler.

## Status

The packages are private workspace packages, consumed in-repo. The docs/ tree predates this design and describes the removed harness and codemode surfaces; it is queued for a rewrite. `platform/model` carries the proven driver; journaled backoff, model-reported limits, provider continuations, and spend reservation are the next behaviors to land on it.

## Why tardigrade

Tardigrades are the most indestructible animals we know of. They survive vacuum, radiation, freezing, and decades without water by turning into a kernel that holds everything needed to come back alive. This harness tries to be the same for agents: everything it is, and everything it will be, derives from a durable append-only log, and a log is very hard to kill.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and run `bun run gate` before finishing a change.
