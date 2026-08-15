# flamecast-core

flamecast-core is a code-first framework for building and evolving agent harnesses around frozen language models.

The event log is the source of truth. Modules compile into an agent. Machines react to the log. Rendering is pure. Runtimes bind storage, routing, and concurrency. Evolution creates new code constructions and reuses recorded work until their observable behavior diverges.

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
import { candidate, costed, gepa, populora, rollout } from "flamecast-core/evolve"
```

## Quick Start

```ts
import { Effect } from "effect"
import { createAgent, defaultPack, keyOf, type NativeTool } from "flamecast-core/harness"
import { InMemoryRuntime } from "flamecast-core/runtime-in-memory"

const lookupInvoice: NativeTool = {
  spec: {
    name: "lookup_invoice",
    description: "Look up one invoice by order id.",
    inputSchema: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"]
    }
  },
  run: (input) =>
    Effect.succeed({
      invoiceId: `invoice-${(input as { orderId: string }).orderId}`
    })
}

const agent = createAgent({
  modules: defaultPack({
    inference: {
      system: "You are a support agent. Use lookup_invoice for order questions."
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

`inference()` uses Vercel AI Gateway by default. Set `AI_GATEWAY_API_KEY`, or pass `vercelGatewayInference({ apiKey })`. Cloudflare AI Gateway is available through `cloudflareGatewayInference()`.

## Design

- Modules own their configuration, projections, and machines.
- Effect services inject typed construction dependencies between modules.
- Static instructions form the cache-friendly system prefix. Conditional nudges are appended near the request tail by default.
- `AgentDefinition` records module provenance and compiled behavior. Source-controlled candidates can supply an explicit agent id such as a commit SHA.
- `agent.branch(log)` and `agent.fork()` create independent in-memory continuations.
- `callAgent()`, `subagentTool()`, and `serve()` enable multi-agent systems without imposing a planner or topology. Origin and usage cross the session boundary, so provenance and cost trees are derived from logs.
- `flamecast-core/codemode` is optional. It lets the model write a script over capabilities the harness developer chose, and fan-out becomes `Promise.all`.
- `flamecast-core/evolve` supplies candidates, observations, cost tracking, rollouts, scoring, Pareto utilities, and GEPA and PopuLoRA search loops. Callers provide costed mutation and evaluation policy.

## Public Imports

| Import | Purpose |
| --- | --- |
| `flamecast-core` | Events, event logs, machines, ports, routing, and conformance |
| `flamecast-core/harness` | Agents, modules, rendering, inference providers, native tools, budgets, contracts, compaction, and delegation |
| `flamecast-core/codemode` | Capabilities, the sandbox port, and the tool that runs model-written scripts |
| `flamecast-core/evolve` | Candidates, finite observations, costed callbacks, forked rollouts, scoring, Pareto selection, GEPA search, and PopuLoRA co-evolution |
| `flamecast-core/runtime-in-memory` | Complete runtime for process-local sessions |

The internal workspaces are private. The root package exposes them through Git-installable subpaths and is not published to npm.

## Documentation

Start with [docs/README.md](docs/README.md). [docs/building-an-agent.md](docs/building-an-agent.md) is the practical guide. [docs/evolution.md](docs/evolution.md) explains the code-first evolution model.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and run `bun run gate` before finishing a change.
