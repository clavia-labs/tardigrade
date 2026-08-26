---
name: tardigrade
description: Create, migrate, author, build, deploy, inspect, and improve Tardigrade actors with the tdg CLI. Use when a task works with an existing agent harness, actor.ts, a Tardigrade thread, or GEPA harness optimization from run traces.
---

# Tardigrade

Read the [CLI guide](../../docs/how-to/cli.md) for initialization, provider setup, local development, deployment, discovery, and method calls. Read the [server guide](../../docs/how-to/server.md) for HTTP routes, configuration, secrets, and model catalog behavior. Read the [Celld guide](../../docs/how-to/celld.md) before deploying to a Celld fleet.

Start a new actor interactively:

```bash
tdg init researcher
cd researcher
```

In a non-interactive terminal, state the provider connection as JSON. The JSON names the secret environment variable and does not contain its value:

```bash
tdg init researcher \
  --provider openrouter \
  --provider-config '{"env":["OPENROUTER_API_KEY"]}' \
  --default-model anthropic/claude-sonnet-4.6
cd researcher
```

Interactive setup writes local credentials to `.dev.vars`. Set the named credential in the platform secret store for a deployment. Add another provider or change the default with focused commands:

```bash
tdg setup provider openai '{"env":["OPENAI_API_KEY"]}'
tdg setup default --provider openai --model gpt-5.2
```

Edit `actor.ts`. Keep the name passed to `actor` stable because builds, calls, deployments, and stored traces use it as actor identity. Add or remove package components in `codeMode([...components])` when the task needs different capabilities.

Build and serve from the actor directory:

```bash
tdg build actor.ts
tdg dev
```

`tdg dev` mounts the actor in the current directory and stores its threads in `.tardigrade/actor.sqlite`. Keep that directory present until the server stops.

Deploy the generated Worker with the platform CLI:

```bash
bunx wrangler deploy
celld deploy --config celld.jsonc --dry-run
celld deploy --config celld.jsonc
```

Keep the server running. From another shell, inspect provider requirements, search models, discover methods, and call one:

```bash
tdg providers --json
tdg models --provider openrouter --search claude --json
tdg methods --json
tdg call message '{"text":"Read this repository and tell me what it does"}'
```

Use `--json` for programmatic output. Use `--url` and `--token` for another server. The URL addresses the actor mounted at that origin. Open the trace URL printed by `tdg call` to inspect the trajectory in Voyager.

## Migrate an existing harness

Read the [migration guide](../../docs/how-to/migrate.md) before editing. Inventory the loop, tools, policies, output, persistence, API, client, history, and deployment configuration. Capture a matched baseline, preserve behavior through the first pass, import complete history through the host seed path, and verify with existing tests and a local Tardigrade run.

Finish with the Voyager trace URL, a concise change summary, and comparable before-and-after harness lines, dependencies, model tokens, cost, and latency. Label unavailable metrics.

## Improve a harness

When optimizing an existing actor, read [references/gepa.md](references/gepa.md) before changing `actor.ts`. Score runs, reflect on their traces, propose actor changes, and test each candidate through the CLI.
