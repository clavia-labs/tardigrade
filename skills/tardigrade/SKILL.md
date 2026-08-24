---
name: tardigrade
description: Create, migrate, author, build, push, run, inspect, and improve Tardigrade actors with the tdg CLI. Use when a task works with an existing agent harness, actor.ts, the local actor registry, a Tardigrade run, or GEPA harness optimization from run traces.
---

# Tardigrade

Read the [CLI guide](../../docs/how-to/cli.md) for initialization, provider setup, build, push, discovery, and method calls. Read the [server guide](../../docs/how-to/server.md) for HTTP routes, configuration, secrets, model catalog behavior, and deployment.

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
  --default-model anthropic/claude-sonnet-4-6
cd researcher
```

Set the named credential in the environment that runs the server. Add another provider or change the default with focused commands:

```bash
tdg setup provider openai '{"env":["OPENAI_API_KEY"]}'
tdg setup default --provider openai --model gpt-5.2
```

Edit `actor.ts`. Keep the name passed to `defineActor` stable because build, push, calls, and stored traces use it as actor identity. Add or remove package components in `codeMode([...components])` when the task needs different capabilities.

Build, push, and serve from the actor directory:

```bash
tdg build actor.ts
tdg push actor.ts --target local
tdg dev
```

Keep the server running. From another shell, inspect provider requirements, search models, discover methods, and call one:

```bash
tdg providers --json
tdg models --provider openrouter --search claude --json
tdg methods --actor researcher --json
tdg call message '{"text":"Read this repository and tell me what it does"}' --actor researcher
```

Use `--json` for programmatic output. Use `--url` and `--token` for another server. State `--target local` or `--target hosted` on every push. Open the trace URL printed by `tdg call` to inspect the trajectory in Voyager.

## Migrate an existing harness

Read the [migration guide](../../docs/how-to/migrate.md) before editing. Inventory the loop, tools, policies, output, persistence, API, client, history, and deployment configuration. Capture a matched baseline, preserve behavior through the first pass, import complete history through the host seed path, and verify with existing tests and a local Tardigrade run.

Finish with the Voyager trace URL, a concise change summary, and comparable before-and-after harness lines, dependencies, model tokens, cost, and latency. Label unavailable metrics.

## Improve a harness

When optimizing an existing actor, read [references/gepa.md](references/gepa.md) before changing `actor.ts`. Score runs, reflect on their traces, propose actor changes, and test each candidate through the CLI.
