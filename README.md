<p align="center">
  <br>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img alt="Tardigrade logo: a tardigrade drawn from overlapping circles" src="docs/assets/logo-light.svg" width="170">
  </picture>
</p>

# Tardigrade

A durable and modular agent harness built for self-improvement.

### A harness made for self-improvement

As models get increasingly smart, they will be capable of writing their own harnesses to improve themselves. To enable this, we need a harness that can be inspected, forked, and varied.

How can a harness be fully customizable, easy to author and yet remain reliable in production? We took inspiration from React. Designing a harness is like designing a user interface, except the user is a language model. React declared the component tree as a function of state: `UI = f(state)` and the set of valid state transitions as `{transitions} = f(state)`. This simplicity enabled expressiveness in authoring applications without sacrificing reliability. A harness needs the same shape, but with the log as state.

$$\lbrace\mathrm{transitions}\rbrace = f(\mathrm{log})$$

## Quickstart

Prerequisites: Bun 1.3 or later and a model endpoint.

```bash
bun add @clavia/tardigrade
```

Build a durable codemode agent by combining capabilities.

```ts
import { agentOf, budget, codeMode, compaction, reply } from "@clavia/tardigrade"
import { infer } from "@clavia/tardigrade/model"
import { createBunHost } from "@clavia/tardigrade/bun/host"
import { fileTelemetry } from "@clavia/tardigrade/bun/file"

const agent = agentOf([codeMode, reply, budget, compaction])

const host = await createBunHost({
  log: "agents.sqlite",
  actorFor: () => agent,
  layersFor: () => infer({ baseUrl: process.env.MODEL_BASE_URL!, apiKey: process.env.MODEL_API_KEY!, model: process.env.MODEL_ID!, provider: "bedrock" }),
  telemetry: fileTelemetry("spans.ndjson")
})
await host.deliver("bun:main", { type: "MessageReceived", id: "m1", text: "What changed in the deploy?", at: Date.now() })
await host.drive()
```

The run leaves its spans in `spans.ndjson`. The ClickHouse binary (`brew install clickhouse`) queries the file in place, no server:

```bash
clickhouse local -q "
  SELECT SpanName, SpanAttributes['outcome'] AS outcome, Duration / 1e6 AS ms
  FROM file('spans.ndjson', JSONEachRow,
    'Timestamp String, SpanName String, Duration UInt64, SpanAttributes Map(String, String)')
  ORDER BY Timestamp"
```

## Docs
*work in progress*

- [Quickstart](docs/quickstart.md): all the core concepts you need to get started.
- [Publish](docs/how-to/publish.md): publish RC and stable releases to npm.
- [Why tardigrade](docs/explanations/why.md): {transitions} = f(log), and what the log-as-state shape enables.

## Layout

```
packages/
  core/      contracts: Event, EventLog, KeyFragment, Transition, Reactor, Router
  code/      durable code execution
  agent/     capabilities, the runtime (`agentOf`), and the RLM default (`createRlmAgent`)
  host/      the reference in-memory binding
platform/
  model/     the Infer binding over TanStack AI
   bun/       the durable host binding: SQLite through @effect/sql-sqlite-bun
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and run `bun run gate` before finishing a change.
