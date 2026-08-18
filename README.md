# Tardigrade

Tardigrade is a durable agent harness built with the log as its core, inspired by event sourcing and React. State at any point is a pure function of the log, and the harness is a set of transitions derived from it.

$$\{\mathrm{transitions}\} = f(\mathrm{log})$$

## Quickstart

An agent is reactors over one log. Assemble one, give it a durable log, send it a message.

```ts
import { Effect, Layer } from "effect"
import { actor } from "@flamecast/core/actor"
import { composeKeys } from "@flamecast/core/event-log"
import { messageKeys } from "@flamecast/core/message"
import { codeReactor, codeKeys } from "@flamecast/code"
import { jsSandbox, memoryTmp } from "@flamecast/code/defaults"
import { Packages } from "@flamecast/code/packages"
import { agentKeys, budgetReactor, codeSurface, compactionReactor, inferReactor, replyReactor, toolsReactorFor } from "@flamecast/agent"
import { realInfer } from "@flamecast/model/model"
import { createBunHost } from "@flamecast/bun/host"

// The tool surface: code mode is the default. `nativeSurface` presents a fixed table of named
// tools instead, for an agent measured against another harness's surface.
const surface = codeSurface("none")

// Adding a capability is adding a reactor to the list.
const agent = actor(
  [inferReactor, budgetReactor, toolsReactorFor(surface), codeReactor, replyReactor, compactionReactor],
  composeKeys(messageKeys, codeKeys, agentKeys)
)

// The wiring: a real model through platform/model, a sandbox for the agent's code, your packages.
// The binding renders the same surface the actor serves.
const wiring = () =>
  Layer.mergeAll(
    realInfer({ baseUrl: process.env.MODEL_BASE_URL!, apiKey: process.env.MODEL_API_KEY!, model: process.env.MODEL_ID!, provider: "bedrock", surface, maxOutputTokens: 64_000 }),
    Layer.succeed(Packages, { resolve: () => undefined, list: () => Effect.succeed([]) }),
    jsSandbox,
    memoryTmp()
  )

const host = await createBunHost({ path: "agents.sqlite", actorFor: () => agent, layersFor: wiring })
await host.deliver("bun:main", { type: "MessageReceived", id: "m1", text: "What changed in the deploy?", at: Date.now() })
await host.drive()
```

`createRlmAgent` from `@flamecast/agent` is this Recursive Language Model default: the same six reactors, an in-process host, packages, and spawn. The mind is `agentFor` (infer, tools, reply). Add budget, code, or compaction when the harness needs them.

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

## Docs

Organized on the Diátaxis grid: learning, tasks, information, understanding.

- [Quickstart](docs/quickstart.md): the concepts in one page: events, projections, transitions, reactors, an agent in three reactors.
- [Tutorial: an RLM agent](docs/tutorials/rlm-agent.md): a Recursive Language Model agent with durable code execution, killed mid-recursion.
- [How-to: gate tools](docs/how-to/gate-tools.md): hide, reveal, or revoke tools from the log.
- [Reference: API](docs/reference/api.md): Event, Projection, Transition, Reactor, Actor, send, settle, resting.
- [Why tardigrade](docs/explanations/why.md): state = f(log), the convergence of durable systems, agents as the new users.
- [Reactors](docs/explanations/reactors.md): the reactor model, with the React analogy and the math.
- [Actors](docs/explanations/actors.md): one log, its reactors, and the settle loop.

## Layout

```
packages/
  core/      contracts: Event, EventLog, KeyFragment, Transition, Reactor, Router
  code/      durable code execution
  agent/     reactors, the mind (`agentFor`), and the RLM default (`createRlmAgent`)
  host/      the reference in-memory binding
platform/
  model/     the Infer binding over TanStack AI
  bun/       the durable host binding: SQLite through @effect/sql
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and run `bun run gate` before finishing a change.
