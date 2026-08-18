# Tardigrade

### Log is all you need

Tardigrade is a durable agent harness built with the log as its core. State at any point is a pure function of the log, and the harness is a set of transitions derived from it.

$$\{\mathrm{transitions}\} = f(\mathrm{log})$$

## Quickstart

Prerequisites: bun 1.1 or later, and a model endpoint.

An agent is reactors over one log.

```ts
import { Effect, Layer } from "effect"
import { actor } from "@tardigrade/core/actor"
import { composeKeys } from "@tardigrade/core/event-log"
import { messageKeys } from "@tardigrade/core/message"
import { codeReactor, codeKeys } from "@tardigrade/code"
import { jsSandbox, memoryTmp } from "@tardigrade/code/defaults"
import { Packages } from "@tardigrade/code/packages"
import { agentKeys, budgetReactor, codeSurface, compactionReactor, inferReactor, replyReactor, toolsReactorFor } from "@tardigrade/agent"
import { realInfer } from "@tardigrade/model/model"
import { createBunHost } from "@tardigrade/bun/host"
import { otlpTelemetry } from "@tardigrade/bun/otlp"

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

// Spans go to any OTLP listener (docs/how-to/observe.md).
const host = await createBunHost({
  path: "agents.sqlite",
  actorFor: () => agent,
  layersFor: wiring,
  telemetry: otlpTelemetry({ baseUrl: "http://localhost:4318", serviceName: "quickstart" })
})
await host.deliver("bun:main", { type: "MessageReceived", id: "m1", text: "What changed in the deploy?", at: Date.now() })
await host.drive()
```

The snippet already emits spans to `localhost:4318`. To land them in ClickHouse, front it with the [OTel Collector](https://github.com/open-telemetry/opentelemetry-collector-releases/releases):

```bash
brew install clickhouse && clickhouse server
otelcol-contrib --config=collector.yaml
```

```yaml
# collector.yaml
receivers:
  otlp: { protocols: { http: { endpoint: 0.0.0.0:4318 } } }
exporters:
  clickhouse: { endpoint: tcp://localhost:9000, database: otel, create_schema: true }
service:
  pipelines:
    traces: { receivers: [otlp], exporters: [clickhouse] }
```

```sql
SELECT SpanName, SpanAttributes['outcome'] AS outcome, Duration / 1e6 AS ms
FROM otel.otel_traces ORDER BY Timestamp
```

## Concepts

### Events

An event is the smallest primitive. It's an immutable fact, recorded once in the event log. You define events based on what's meaningful in your domain. For example, when building an agent, your events could be `MessageReceived`, `ToolCalled` etc.

```ts
// An Event is an open record. Concrete events narrow it.
type Event = { type: string } & Record<string, unknown>

type MessageReceived = { type: "MessageReceived"; id: string; text: string; at: number }
type ToolCalled = { type: "ToolCalled"; callId: string; name: string; arguments: unknown }
type ToolReturned = { type: "ToolReturned"; callId: string; result: unknown }
type TurnCompleted = { type: "TurnCompleted"; output: string }
```

### Projections

A projection is a pure function that takes an event log and returns a value. Projections help to slice an event log into different views based on the consumer.

```ts
type Projection<T> = (events: ReadonlyArray<Event>) => T

// done: the turn has reached its terminal.
const done: Projection<boolean> = (events) => events.some((e) => e.type === "TurnCompleted")
```

### Transitions and reactors

A transition is a keyed unit of state change. It takes in state, and returns new events. Reactors compute the transitions enabled by a given event log.

```ts
// state in, events out. A retried fire is the same work, absorbed by its key.
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

- [Quickstart](docs/quickstart.md): the concepts in one page: events, projections, transitions, reactors, an agent in three reactors.
- [Tutorial: an RLM agent](docs/tutorials/rlm-agent.md): a Recursive Language Model agent with durable code execution, killed mid-recursion.
- [How-to: gate tools](docs/how-to/gate-tools.md): hide, reveal, or revoke tools from the log.
- [How-to: observe](docs/how-to/observe.md): wire a tracer, traces in ClickHouse, the one-trace contract, the outcome vocabulary.
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
   bun/       the durable host binding: SQLite through @effect/sql-sqlite-bun
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and run `bun run gate` before finishing a change.
