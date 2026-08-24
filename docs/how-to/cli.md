# CLI

`tdg` runs a tardigrade server and talks to one.

## Install

```bash
bun add -g tardie
```

Or run it without installing: `bunx tardie <command>`. Bun 1.4 or later.

## Quickstart

```bash
tdg setup                  # provider connection and default model
tdg dev                    # API and UI on http://localhost:4242
tdg methods
tdg call message '{"text":"read this repo and tell me what it does"}'
```

## Commands

| Command | |
| --- | --- |
| `tdg setup` | Save a provider connection and choose the default model |
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

A flag beats an environment variable, which beats `~/.tardigrade/config.json`, which beats the default. This order applies to remote URL and token settings. Project model configuration lives in `tardigrade.jsonc`. Provider credentials live in `.env`.

| | Flag | Environment | Default |
| --- | --- | --- | --- |
| Server to call | `--url` | | `http://localhost:4242` |
| Bearer token | `--token` | `TARDIGRADE_TOKEN` | none |
| Port for `dev` | `--port` | `PORT` | `4242`, then lower if occupied |
| Store for `dev` | `--db` | `TARDIGRADE_DB` | `.tardigrade/agents.sqlite` |
| Concurrent lanes for `dev` | `--max-concurrent-lanes` | `TARDIGRADE_MAX_CONCURRENT_LANES` | `4` |
| Project configuration | | `TARDIGRADE_CONFIG_PATH` | `tardigrade.jsonc` |
| Provider credentials | | Variables named by each provider's `env` list | what `tdg setup` saved in `.env` |

`tdg setup` updates `tardigrade.jsonc` and stores the credential in the project `.env` at mode 0600. It never prints the credential back. Run setup again to add another provider connection or change the default model. Each run preserves unrelated JSONC settings, comments, environment entries, and earlier provider connections. With no provider configured the server still boots and serves every read; it says so at boot and turns fail naming what is missing.

An agent or CI job can avoid prompts by stating every setup value. The credential value comes from the environment variable named by `--credential-env` and never appears in the command arguments:

```bash
tdg setup \
  --provider openrouter \
  --base-url https://openrouter.ai/api/v1 \
  --driver openai-chat-completions \
  --credential-env OPENROUTER_API_KEY \
  --default-model anthropic/claude-sonnet-4-6
```

Partial declarative setup fails and lists the missing flags. A missing `OPENROUTER_API_KEY` also fails before either file changes.

```jsonc
{
  "models": {
    "default": { "provider": "openrouter", "model_id": "anthropic/claude-sonnet-4-6" },
    "providers": {
      "openrouter": {
        "baseUrl": "https://openrouter.ai/api/v1",
        "driver": "openai-chat-completions",
        "env": ["OPENROUTER_API_KEY"]
      }
    }
  }
}
```

```dotenv
OPENROUTER_API_KEY='your-key'
```

Setup offers OpenAI, Anthropic, OpenRouter, Vercel AI Gateway, Cloudflare AI Gateway, Microsoft Foundry, Google AI, Google Vertex AI, Amazon Bedrock, and a custom endpoint. It uses [models.dev](https://models.dev) for the searchable default-model list and standard credential variable names. The server resolves model windows, output limits, and pricing from its validated catalog snapshot.

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
tdg call message '{"text":"take a deeper pass","model":"anthropic/claude-opus-4-6"}' --actor reviewer
tdg call inspect '{"path":"README.md"}' --actor reviewer --no-wait
tdg actors
tdg build ./actors/reviewer.ts
tdg push ./actors/reviewer.ts --target local
tdg ls --url https://tardigrade.example.com --token "$TOKEN"
tdg events root --types TurnFailed
tdg dev --port 8080 --db runs.sqlite
tdg dev --max-concurrent-lanes 5
```
