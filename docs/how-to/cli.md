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
tdg run "read this repo and tell me what it does"
```

## Commands

| Command | |
| --- | --- |
| `tdg setup` | Save a provider, a model id, and a key |
| `tdg build <entry>` | Build and validate an actor artifact |
| `tdg push <entry> --target <local\|hosted>` | Build and push an actor |
| `tdg dev` | Serve the API and the UI on one port |
| `tdg actors` | List actors available on the server |
| `tdg run <brief>` | Start a thread and wait for its answer |
| `tdg send <thread> <brief>` | Send to a thread, do not wait |
| `tdg ls` | List threads |
| `tdg events <thread>` | Print a thread's log |

Commands that print data take `--json` where their help lists it. Remote commands take `--url` and `--token`. `tdg <command> --help` prints the rest.

## Configuration

A flag beats an environment variable, which beats `~/.tardigrade/config.json`, which beats the default.

| | Flag | Environment | Default |
| --- | --- | --- | --- |
| Server to call | `--url` | | `http://localhost:4242` |
| Bearer token | `--token` | `TARDIGRADE_TOKEN` | none |
| Port for `dev` | `--port` | `PORT` | `4242`, then lower if occupied |
| Store for `dev` | `--db` | `TARDIGRADE_DB` | `.tardigrade/agents.sqlite` |
| Model | | `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_ID`, `MODEL_PROVIDER`, `MODEL_OUTPUT_GUARANTEE`, `MODEL_OUTPUT_WITH_TOOLS` | what `tdg setup` saved |

`tdg setup` writes the file at mode 0600 and never prints the key back. With no model configured the server still boots and still serves every read; it says so at boot and turns fail naming what is missing.

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
tdg run "summarize the open PRs" --json
tdg actors
tdg build ./actors/reviewer.ts
tdg push ./actors/reviewer.ts --target local
tdg ls --url https://tardigrade.example.com --token "$TOKEN"
tdg events root --types TurnFailed
tdg dev --port 8080 --db runs.sqlite
```
