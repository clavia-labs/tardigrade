# CLI

`tdg` runs a tardigrade server and talks to one.

## Install

```bash
bun add -g tardie
```

Or run it without installing: `bunx tardie <command>`. Bun 1.4 or later.

## Quickstart

```bash
tdg init researcher
cd researcher
tdg push actor.ts --target local
tdg dev
tdg methods --actor researcher
tdg call message '{"text":"read this repo and tell me what it does"}' --actor researcher
```

## Commands

| Command | |
| --- | --- |
| `tdg init <name>` | Create an actor and configure its first provider connection |
| `tdg setup` | Add provider connections, then choose the default model |
| `tdg setup provider` | Add or update one provider connection |
| `tdg setup default` | Choose the default model from configured providers |
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
| Model catalog cache | | `TARDIGRADE_MODEL_CATALOG_CACHE` | `.tardigrade/models.json` |
| Provider credentials | | Variables named by each provider's `env` list | what interactive `tdg init` or `tdg setup` saved in `.env` |

`tdg init` asks for a provider connection and default model. It creates an actor whose `infer` options match that selection, writes the public connection to `tardigrade.jsonc`, and stores the credential in `.env` at mode 0600. It never prints the credential back. Run `tdg setup` inside the actor directory to add one or more provider connections, choose the default provider and model once, review the plan, and confirm the write. Existing providers remain available when the flow asks for the default. `tdg setup provider` changes connections without changing the default. Its declarative form accepts a provider name and a JSON connection object. The object names secret environment variables and does not contain or write their values. `tdg setup default` changes the default without writing credentials. Setup preserves unrelated JSONC settings, comments, environment entries, and provider connections. With no provider configured the server still boots and serves every read; it says so at boot and turns fail naming what is missing.

An agent or CI job can avoid prompts by stating every provider value during initialization. The credential value comes from the environment variable named by `--credential-env` and never appears in the command arguments:

```bash
tdg init researcher \
  --provider openrouter \
  --base-url https://openrouter.ai/api/v1 \
  --driver openai-chat-completions \
  --credential-env OPENROUTER_API_KEY \
  --default-model anthropic/claude-sonnet-4-6
```

Partial declarative initialization fails and lists the missing flags. A missing `OPENROUTER_API_KEY` also fails before any project file changes. Agents and CI can add a connection and select it as the default in two focused commands:

```bash
tdg setup provider openrouter '{"env":["OPENROUTER_API_KEY"]}'

tdg setup default \
  --provider openrouter \
  --model anthropic/claude-sonnet-4-6
```

Known providers supply their standard driver and endpoint. A provider whose connection needs more fields states them in the same object. Amazon Bedrock requires its gateway endpoint and AWS region:

```bash
tdg setup provider amazon-bedrock '{"baseUrl":"https://gateway.example.com/bedrock","region":"ap-southeast-1","env":["CLOUDFLARE_API_TOKEN"]}'
```

A custom provider declares its endpoint and driver:

```bash
tdg setup provider private-gateway '{"baseUrl":"https://models.example.com/v1","driver":"openai-responses","env":["PRIVATE_MODEL_KEY"]}'
```

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

Initialization and setup offer OpenAI, Anthropic, OpenRouter, Vercel AI Gateway, Cloudflare AI Gateway, Microsoft Foundry, Google AI, Google Vertex AI, Amazon Bedrock, and a custom endpoint. They use [models.dev](https://models.dev) for the searchable default-model list and standard credential variable names. The first interactive run saves the validated public catalog in `.tardigrade/models.json`; later runs load that snapshot without another request. A cached list says `cached catalog`. The list omits models whose catalog entry explicitly rules out text output or tool calls. Models with missing capability data remain visible, and manual entry remains available. `tdg dev` refreshes the same cache when its server starts and keeps the resolved snapshot in memory. The server resolves model windows, output limits, and pricing from that snapshot. Set every environment variable named by a declarative provider before the server starts. Hosted platforms should inject those values through their secret store.

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
