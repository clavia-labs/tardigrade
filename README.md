# flamecast-core

flamecast-core is a code-first framework for building reliable agent harnesses around frozen language models.

The event log is the source of truth. Modules compile into an agent. Machines react to the log. Rendering is pure. Runtimes bind storage, routing, and concurrency.

## Install

Install Effect and a pinned Git revision directly from GitHub:

```sh
bun add effect@4.0.0-rc.108
bun add --trust "git+ssh://git@github.com/clavia-inc/flamework.git#<commit>"
```

Build output is generated from the pinned source during installation and is not committed. Bun requires `--trust` because Git dependencies cannot run lifecycle scripts without the consumer's explicit permission.

The root export is the core package. The other packages use subpath exports:

```ts
import { EventLog } from "flamecast-core"
import { createAgent, inference } from "flamecast-core/harness"
import { InMemoryRuntime } from "flamecast-core/runtime-in-memory"
```

## Quick Start

```ts
import { Effect, Schema } from "effect"
import { createAgent, defaultPack, keyOf, tool } from "flamecast-core/harness"
import { InMemoryRuntime } from "flamecast-core/runtime-in-memory"

const lookupInvoice = tool({
  name: "lookup_invoice",
  description: "Look up one invoice by order id.",
  input: Schema.Struct({ orderId: Schema.String }),
  run: (input) =>
    Effect.succeed({
      invoiceId: `invoice-${input.orderId}`
    })
})

const agent = createAgent({
  modules: defaultPack({
    inference: {
      system: "You are a support agent. Use lookup_invoice for order questions.",
      contextWindow: 200_000
    },
    nativeTools: [lookupInvoice],
    budget: { defaultBudget: 24 }
  })
})

const result = await Effect.runPromise(
  Effect.provide(
    agent.turn({ id: "m-1", text: "Find the invoice for order 4182." }),
    InMemoryRuntime({ keyOf, session: "user-42" })
  )
)

if (result.kind === "completed") console.log(result.output)
```

`inference(options)` uses Vercel AI Gateway by default. Set `AI_GATEWAY_API_KEY`, or pass `vercelGatewayInference({ apiKey })`. Cloudflare AI Gateway is available through `cloudflareGatewayInference()`. A module names either a provider or a `contextWindow`, because what a model accepts is not something the framework can guess. `yield* vercelGatewayInference()` reads that number from the gateway's model catalog.

## Design

- Modules own their configuration, services, render contributions, and machines.
- Effect services inject typed construction dependencies between modules.
- Static instructions form the cache-friendly system prefix. Conditional nudges are appended near the request tail by default.
- `AgentDefinition` records module provenance and compiled behavior. Source-controlled programs can supply an explicit agent id such as a commit SHA.
- `agent.branch(log)` and `agent.fork()` create independent in-memory continuations.
- `callAgent()`, `subagentTool()`, and `serve()` enable multi-agent systems without imposing a planner or topology. Origin and usage cross the session boundary, so provenance and cost trees are derived from logs.
- `flamecast-core/codemode` is optional. It lets the model write a script over capabilities the harness developer chose, and fan-out becomes `Promise.all`.
- Search and evaluation policy stay in application code. Optimizers can use logs, pure request rendering, explicit agent ids, and independent branches without making their problem-specific policy part of the execution engine.

## Public Imports

| Import | Purpose |
| --- | --- |
| `flamecast-core` | Events, event logs, machines, ports, routing, and conformance |
| `flamecast-core/harness` | Agents, modules, rendering, inference providers, native tools, budgets, contracts, compaction, and delegation |
| `flamecast-core/codemode` | Capabilities, the sandbox port, and the tool that runs model-written scripts |
| `flamecast-core/runtime-in-memory` | Complete runtime for process-local sessions |

The internal workspaces are private. The root package exposes them through Git-installable subpaths and is not published to npm.

## Documentation

Start with [docs/README.md](docs/README.md). [docs/building-an-agent.md](docs/building-an-agent.md) is the practical guide.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and run `bun run gate` before finishing a change.
