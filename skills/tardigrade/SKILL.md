---
name: tardigrade
description: Create, migrate, author, build, push, run, inspect, and improve Tardigrade actors with the tdg CLI. Use when a task works with an existing agent harness, actor.ts, the local actor registry, a Tardigrade run, or GEPA harness optimization from run traces.
---

# Tardigrade

Use the generated quickstart as the starting point for a new actor:

```bash
tdg init researcher
cd researcher
```

Edit `actor.ts`. Keep `actorName` stable because build, push, run, and stored traces use it as the actor identity. Put the agent's role and expected answer in `actorInstructions`. Add or remove package components in `codeMode([...components])` only when the task needs different capabilities.

Build the source, push the same actor into the local registry, and start the local server from the actor directory:

```bash
tdg build actor.ts
tdg push actor.ts --target local
tdg dev
```

Keep the server running. Start a run from another shell in the same directory:

```bash
tdg run "Read this repository and tell me what it does" --actor researcher
```

Open the trace URL printed by `tdg run` to inspect the live trajectory in Voyager.

State `--target local` or `--target hosted` on every push. When the server URL differs from the client default, pass the URL to commands that call it:

```bash
tdg run "Investigate the failure" --actor researcher --url http://localhost:4241
```

Use `--json` when another program consumes command output. Human output includes workflow guidance and trace links.

## Migrate an existing harness

When the task moves an existing agent application to Tardigrade, read [the migration guide](../../docs/how-to/migrate.md) before editing. Inventory the existing loop, tools, policies, output, persistence, API, client, history, and deployment configuration. Capture one matched baseline, preserve behavior through the first pass, import complete history through the host seed path, and verify the result with the existing tests and a local Tardigrade run.

Finish with the Voyager trace URL, a concise change summary, and before-and-after harness lines, dependencies, model tokens, cost, and latency. Calculate percentage changes only for comparable values and label unavailable metrics.

## Improve a harness

When the task is to optimize an existing actor, read [references/gepa.md](references/gepa.md) before changing `actor.ts`. Act as the optimizer: score runs, reflect on their traces, propose actor changes, and test each candidate through the CLI.
