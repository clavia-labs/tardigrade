# CLI

`tdg` runs a tardigrade server and talks to one.

## Install

```bash
bun add -g tardie
```

Or run it without installing: `bunx tardie <command>`. Bun 1.4 or later.

## Quickstart

```bash
tdg setup                  # provider, model, key
tdg dev                    # API and UI on http://localhost:4242
tdg methods
tdg call message '{"text":"read this repo and tell me what it does"}'
```

## Commands

| Command | |
| --- | --- |
| `tdg setup` | Save a provider, a model id, and a key |
| `tdg build <entry>` | Build and validate an actor artifact |
| `tdg push <entry> --target <local\|hosted>` | Build and push an actor |
| `tdg dev` | Serve the API and the UI on one port |
| `tdg actors` | List actors available on the server |
| `tdg methods` | List an actor's methods and schemas |
| `tdg call <method> <input>` | Call a method with JSON input and wait for its result |
| `tdg ls` | List threads |
| `tdg events <thread>` | Print a thread's log |

Commands that print data take `--json` where their help lists it. Remote commands take `--url` and `--token`. A call creates a thread unless `--thread` names one. Use `--no-wait` to print its durable handle immediately. `tdg <command> --help` prints the rest.

## Configuration

A flag beats an environment variable, which beats `~/.tardigrade/config.json`, which beats the default.

| | Flag | Environment | Default |
| --- | --- | --- | --- |
| Server to call | `--url` | | `http://localhost:4242` |
| Bearer token | `--token` | `TARDIGRADE_TOKEN` | none |
| Port for `dev` | `--port` | `PORT` | `4242`, then lower if occupied |
| Store for `dev` | `--db` | `TARDIGRADE_DB` | `.tardigrade/agents.sqlite` |
| Concurrent lanes for `dev` | `--max-concurrent-lanes` | `TARDIGRADE_MAX_CONCURRENT_LANES` | `4` |
| Model directory | | | what `tdg setup` saved |

`tdg setup` writes the file at mode 0600 and never prints the key back. Run it again to add another provider or model. Each run preserves earlier entries and selects the new `{ provider, model_id }` coordinate as the default. With no model configured the server still boots and still serves every read; it says so at boot and turns fail naming what is missing.

Setup offers OpenAI, Anthropic, OpenRouter, Vercel AI Gateway, Cloudflare AI Gateway, Microsoft Foundry, Google AI, Google Vertex AI, Amazon Bedrock, and a custom endpoint. It reads model windows, output limits, and pricing from [models.dev](https://models.dev), then asks you to confirm the endpoint's structured-output guarantee. The selected metadata is stored beside its provider route, so replay can resolve the same coordinate without a network lookup.

## What the actor can reach

| Package | Methods | Reach |
| --- | --- | --- |
| `files` | `read`, `list`, `search`, `write` | Under the working directory only |
| `fetch` | `get`, `request` | Any host, response truncated past a cap |
| `agents` | `run`, `result` | Spawns child threads |
| `workspace` | `read`, `grep` | Values a large result spilled to the store |

No shell: a directory or a host list can be scoped and a shell cannot.

## Examples

```bash
tdg methods --actor reviewer
tdg call message '{"text":"summarize the open PRs"}' --actor reviewer --json
tdg call inspect '{"path":"README.md"}' --actor reviewer --no-wait
tdg actors
tdg build ./actors/reviewer.ts
tdg push ./actors/reviewer.ts --target local
tdg ls --url https://tardigrade.example.com --token "$TOKEN"
tdg events root --types TurnFailed
tdg dev --port 8080 --db runs.sqlite
tdg dev --max-concurrent-lanes 5
```
