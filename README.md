# flamecast-core

flamecast-core is a code-first framework for building and evolving agent harnesses around frozen language models.

The event log is the source of truth. Modules compile into an agent program. Machines react to the log. Rendering is pure. Runtimes bind storage, routing, and concurrency. Evolution creates new code constructions and reuses recorded work until their observable behavior diverges.

## Install

Install a pinned Git revision directly from GitHub:

```sh
bun add "git+ssh://git@github.com/clavia-inc/flamework.git#<commit>"
```

The root export is the core package. The other packages use subpath exports:

```ts
import { EventLog } from "flamecast-core"
import { createAgent, inference } from "flamecast-core/harness"
import { MemoryRuntime } from "flamecast-core/runtime-memory"
import { candidate, rollout } from "flamecast-core/evolve"
```

## Quick Start

```ts
import { Effect } from "effect"
import { createAgent, defaultPack, keyOf, type Tool } from "@flamecast/harness"
import { MemoryRuntime } from "@flamecast/runtime-memory"

const lookupInvoice: Tool = {
  spec: {
    name: "lookup_invoice",
    description: "Look up one invoice by order id.",
    inputSchema: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"]
    }
  },
  run: (input) => Effect.promise(() => db.invoiceForOrder((input as { orderId: string }).orderId))
}

const agent = createAgent({
  modules: defaultPack({
    inference: {
      system: "You are a support agent. Use lookup_invoice for order questions."
    },
    tools: [lookupInvoice],
    budget: { defaultBudget: 24 }
  })
})

const result = await Effect.runPromise(
  Effect.provide(
    agent.turn({ id: "m-1", text: "Find the invoice for order 4182." }),
    MemoryRuntime({ keyOf, session: "user-42" })
  )
)
```

`inference()` uses Vercel AI Gateway by default. Set `AI_GATEWAY_API_KEY`, or pass `vercelGatewayInference({ apiKey })`. Cloudflare AI Gateway is available through `cloudflareGatewayInference()`.

For a keyless runnable example, use:

```sh
bun run examples/support-agent/main.ts
bun run examples/replay/main.ts
```

## Design

- Modules own their instructions, tools, thresholds, and machines.
- Typed signals let modules announce state and declare dependencies.
- Static instructions form the cache-friendly system prefix. Conditional nudges are appended near the request tail by default.
- `AgentProgram` records module provenance and compiled behavior. Source-controlled candidates can supply an explicit program id such as a commit SHA.
- `agent.branch(log)` and `agent.fork()` create independent in-memory continuations.
- `Router` and `agentTool()` enable multi-agent systems without imposing a planner or topology.
- `@flamecast/evolve` supplies generic candidate, observation, rollout, scoring, and Pareto utilities. Search algorithms remain external.

## Packages

| Package | Purpose |
| --- | --- |
| `@flamecast/core` | Envelopes, event logs, machines, ports, routing, and conformance |
| `@flamecast/harness` | Agent programs, modules, rendering, inference providers, tools, budgets, contracts, and compaction |
| `@flamecast/evolve` | Algorithm-neutral candidates, finite observations, forked rollouts, scoring, and Pareto selection |
| `@flamecast/runtime-memory` | In-process bindings for development, tests, and examples |

The packages are private workspace packages and are not published to npm.

## Documentation

Start with [docs/README.md](docs/README.md). [docs/building-an-agent.md](docs/building-an-agent.md) is the practical guide. [docs/evolution.md](docs/evolution.md) explains the code-first evolution model.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and run `bun run gate` before finishing a change.
