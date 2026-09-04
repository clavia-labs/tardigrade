---
name: tardigrade
description: Create, migrate, author, build, deploy, inspect, and improve Tardigrade actors with the tdg CLI. Use when a task works with an existing agent harness, actor.ts, a Tardigrade thread, or harness optimization from run traces.
---

# Tardigrade

Read [Why Tardigrade?](../../docs/start-here/Why.mdx) for the framework's design, [Concepts](../../docs/getting-started/concepts.mdx) for an overview of its model, and the [Quickstart](../../docs/getting-started/quickstart.mdx) for setup and component authoring. Read the [CLI guide](../../docs/references/cli.mdx) for initialization, provider setup, local development, deployment, discovery, and method calls. Read the [server guide](../../docs/how-to/server.md) for HTTP routes, configuration, secrets, and model catalog behavior. Read the [Cloudflare guide](../../docs/platforms/cloudflare.mdx) before deploying to Cloudflare and the [Celld guide](../../docs/platforms/celld.mdx) before deploying to a Celld fleet.

## Start with the quickstart

Create a small actor with the quickstart template before adding more components. Start interactively:

```bash
tdg init researcher --template quickstart
cd researcher
```

In a non-interactive terminal, state the provider connection as JSON. The JSON names the secret environment variable and does not contain its value:

```bash
tdg init researcher \
  --template quickstart \
  --provider openrouter \
  --provider-config '{"env":["OPENROUTER_API_KEY"]}' \
  --default-model anthropic/claude-sonnet-4.6
cd researcher
```

Interactive setup writes local credentials to `.dev.vars`. Set the named credential in the platform secret store for a deployment.

Build and serve from the actor directory:

```bash
tdg build actor.ts
bun run dev
```

The generated `server.ts` mounts the actor and stores its threads in `.tardigrade/actor.sqlite`. Keep that directory present until the server stops.

Keep the server running. From another shell, discover the actor's methods and call one:

```bash
tdg methods --json
tdg call message '{"text":"What is the weather in Singapore?"}'
```

## Add components

Edit `actor.ts` after the quickstart runs. Keep the name passed to `actor` stable because builds, calls, deployments, and stored traces use it as actor identity. Add one component for each capability the task needs.

Keep the quickstart composition when the actor needs instructions and a small set of direct tools. Use the RLM composition when the actor needs to write code, fetch sources, delegate work, or store large values outside model context. Replace the quickstart actor with this shape and remove any package the task does not need:

```ts
import {
  actor, agentMethods, agentsPackage, budget, budgetAuthority, caller, codeMode,
  compaction, fetchPackage, infer,
  outputValidateOnce, system, workspacePackage
} from "tardie"

const actorName = "researcher"

const actorInstructions = `
You are ${actorName}, a focused research agent.

Investigate the user's request carefully.
Use fetched sources and delegated reports as evidence.
Return a concise answer with concrete findings.
`.trim()

export default actor({
  name: actorName,
  methods: agentMethods,
  components: [
    infer([
      system(actorInstructions),
      budget([
        codeMode([
          fetchPackage(), agentsPackage(), workspacePackage()
        ])
      ], { authority: caller() }),
      compaction(),
      outputValidateOnce
    ]),
    budgetAuthority()
  ]
})
```

Read the [RLM guide](../../docs/examples/rlm.mdx) for the role of each component and the resulting execution loop. Use the [React RLM chat](../../examples/react-rlm-chat/README.md) when the task needs a runnable server, browser client, subagent threads, or a deployment example.

Add another provider or change the default with focused commands:

```bash
tdg setup provider openai '{"env":["OPENAI_API_KEY"]}'
tdg setup default --provider openai --model gpt-5.2
tdg providers --json
tdg models --provider openrouter --search claude --json
```

Use `--json` for programmatic output. Use `--url` and `--token` for another server. The URL addresses the actor mounted at that origin. Use `tdg events <thread>` to inspect its durable trajectory.

## Deploy

Deploy the generated Worker with the platform CLI:

```bash
bunx wrangler deploy
celld deploy --config celld.jsonc --dry-run
celld deploy --config celld.jsonc
```

## Migrate an existing harness

Read the [migration guide](../../docs/how-to/migrate.md) before editing. Inventory the loop, tools, policies, output, persistence, API, client, history, and deployment configuration. Capture a matched baseline, preserve behavior through the first pass, import complete history through the host seed path, and verify with existing tests and a local Tardigrade run.

Finish with the inspected thread, a concise change summary, and comparable before-and-after harness lines, dependencies, model tokens, cost, and latency. Label unavailable metrics.

## Improve a harness

Choose and state an optimization method before changing `actor.ts`:

- Read [NPO](references/npo.md) for a low-cost prompt optimization that follows one candidate lineage and uses a teacher model to revise the prompt from rollout traces and rewards.
- Read [GEPA](references/gepa.md) when the evaluation has case-level tradeoffs that benefit from a candidate pool, Pareto selection, or combining lessons from multiple lineages.

Keep the cases, scoring, limits, and promotion rule fixed across candidates. Run and inspect every candidate through the CLI.
