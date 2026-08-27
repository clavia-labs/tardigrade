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
tdg dev
tdg methods
tdg call message '{"text":"read this repo and tell me what it does"}'
```

## Commands

| Command | |
| --- | --- |
| `tdg init <name>` | Create an actor and configure its first provider connection |
| `tdg setup` | Add provider connections, then choose the default model |
| `tdg setup provider` | Add or update one provider after initial setup |
| `tdg setup default` | Choose the default model from configured providers |
| `tdg lint <entry>` | Validate an actor's component and method seams |
| `tdg build <entry>` | Build and validate an actor artifact |
| `tdg dev` | Build `actor.ts`, then serve its API and UI on one port |
| `tdg providers` | List provider protocols and setup requirements |
| `tdg models` | Search and page the public model catalog |
| `tdg methods` | List an actor's methods and schemas |
| `tdg call <method> <input>` | Call a method with JSON input and wait for its result |
| `tdg ls` | List threads |
| `tdg events <thread>` | Print a thread's log |

Commands that print data take `--json` where their help lists it. Remote commands take `--url` and `--token`. The URL addresses one mounted actor. A call creates a thread unless `--thread` names one. Use `--no-wait` to print its durable handle immediately. `tdg <command> --help` prints the rest.

## Validate actor composition

Run `tdg lint` against the actor source before building or deploying it:

```bash
tdg lint actor.ts
```

The command bundles the source in a temporary directory and reads the method contracts derived from its components. It fails when a declared method has no handler, a component handles a method absent from the actor surface, several components handle the same method, or a fixed actor reference does not declare the method being called. A caller reference remains a deployment edge because its concrete actor depends on the incoming call.

Successful output names the actor and counts its method and outgoing call seams. Pass `--json` to inspect each method's local or external handling and each call target. The command removes its temporary bundle and does not write an actor artifact.

## Configuration

A flag beats an environment variable, which beats `~/.tardigrade/config.json`, which beats the default. This order applies to remote URL and token settings. Public project configuration lives in `wrangler.jsonc` and `celld.jsonc`. Local provider credentials live in `.dev.vars`.

| | Flag | Environment | Default |
| --- | --- | --- | --- |
| Server to call | `--url` | | `http://localhost:4242` |
| Bearer token | `--token` | `TARDIGRADE_TOKEN` | none |
| Port for `dev` | `--port` | `PORT` | `4242`, then lower if occupied |
| Store for `dev` | `--db` | `TARDIGRADE_DB` | `.tardigrade/actor.sqlite` |
| Concurrent lanes for `dev` | `--max-concurrent-lanes` | `TARDIGRADE_MAX_CONCURRENT_LANES` | `4` |
| Project configuration | | `TARDIGRADE_CONFIG_PATH` | `wrangler.jsonc` |
| Model catalog cache | | `TARDIGRADE_MODEL_CATALOG_CACHE` | `.tardigrade/models.json` |
| Provider credentials | | Variables named by each provider's `env` list | what interactive `tdg init` or `tdg setup` saved in `.dev.vars` |

`tdg init` asks for the actor name when omitted, a provider connection, and a default model. Its target directory must be new. It creates an actor that inherits the host model policy, writes the public connection under `vars.TARDIGRADE_CONFIG` in `wrangler.jsonc` and `celld.jsonc`, and stores the credential in `.dev.vars` at mode 0600. A failed initialization removes the new target directory. Setup adds `.dev.vars*` to `.gitignore` when it stores a credential. It never prints the credential back. Run `tdg setup` inside the actor directory to add one or more provider connections, choose the default provider and model once, review the plan, and confirm the write. Existing providers remain available when the flow asks for the default. The first provider and default are written together, so every configuration produced by the CLI can start a host. After that baseline exists, `tdg setup provider` changes connections without changing the default, and `tdg setup default` changes the default without writing credentials. Setup preserves unrelated platform settings, JSONC comments, local secret entries, and provider connections. `tdg dev` loads `.dev.vars`, then lets process environment values override it. It stores the actor's threads in `.tardigrade/actor.sqlite` under that directory, so keep the actor directory present while the server runs. A deployment uses its platform secret store. With no provider configured the server still boots and serves every read; it says so at boot and turns fail naming what is missing.

An agent or CI job can avoid prompts by supplying the provider connection as JSON during initialization. The JSON names the credential environment variable and never contains its value:

```bash
tdg init researcher \
  --provider openrouter \
  --provider-config '{"env":["OPENROUTER_API_KEY"]}' \
  --default-model anthropic/claude-sonnet-4.6
```

Partial declarative initialization fails and lists the missing options. Declarative initialization does not read or write `OPENROUTER_API_KEY`; set it in the environment that runs the server. Agents and CI can configure the first connection and default atomically:

```bash
tdg setup \
  --provider openrouter \
  --provider-config '{"env":["OPENROUTER_API_KEY"]}' \
  --default-model anthropic/claude-sonnet-4.6
```

Once a valid baseline exists, `tdg setup provider` adds or updates another connection and `tdg setup default` selects an allowed model from a configured provider.

Known providers supply their standard protocol and endpoint. A provider whose connection needs more fields states them in the same object. Amazon Bedrock requires its gateway endpoint and AWS region:

```bash
tdg setup provider amazon-bedrock '{"baseUrl":"https://gateway.example.com/bedrock","region":"ap-southeast-1","env":["CLOUDFLARE_API_TOKEN"]}'
```

A custom provider declares its endpoint and protocol:

```bash
tdg setup provider private-gateway '{"baseUrl":"https://models.example.com/v1","protocol":"openai-responses","env":["PRIVATE_MODEL_KEY"]}'
```

```jsonc
{
  "vars": {
    "TARDIGRADE_CONFIG": {
      "models": {
        "default": { "provider": "openrouter", "model_id": "anthropic/claude-sonnet-4.6" },
        "allow": "*",
        "providers": {
          "openrouter": {
            "baseUrl": "https://openrouter.ai/api/v1",
            "protocol": "openai-chat-completions",
            "env": ["OPENROUTER_API_KEY"]
          }
        }
      }
    }
  }
}
```

```dotenv
OPENROUTER_API_KEY='your-key'
```

Initialization and setup offer OpenAI, Anthropic, OpenRouter, Vercel AI Gateway, Cloudflare AI Gateway, Microsoft Foundry, Google AI, Google Vertex AI, Amazon Bedrock, and a custom endpoint. They use [models.dev](https://models.dev) for the searchable default-model list and standard credential variable names. The first interactive run saves the validated public catalog in `.tardigrade/models.json`; later runs load that snapshot without another request. A cached list says `cached catalog`. The list omits models whose catalog entry explicitly rules out text output or tool calls. Models with missing capability data remain visible, and manual entry remains available. `tdg dev` refreshes the same cache when its server starts and keeps the resolved snapshot in memory. The server resolves model windows, output limits, and pricing from that snapshot. Set every environment variable named by a declarative provider before the server starts. Hosted platforms should inject those values through their secret store.

Once a local or hosted server is running, agents can inspect the same catalog through the typed client commands:

```bash
tdg providers --search gateway --limit 20 --json
tdg models --provider openrouter --search claude --limit 20 --json
```

Each response includes `revision`, `status`, `refreshed_at`, `total`, `limit`, `items`, and an optional `next_cursor`. Pass that cursor with the same search and provider filters to read the next page. A cursor from an older catalog revision or another query is refused, so restart at the first page after either changes. These commands accept `--url` and `--token` when they address another server.

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
tdg methods
tdg call message '{"text":"summarize the open PRs"}' --json
tdg call message '{"text":"take a deeper pass","model":"anthropic/claude-opus-4-6"}'
tdg call inspect '{"path":"README.md"}' --no-wait
tdg providers --json
tdg models --provider openrouter --search claude --json
tdg lint actor.ts
tdg build actor.ts
tdg ls --url https://tardigrade.example.com --token "$TOKEN"
tdg events root --types TurnFailed
tdg dev --port 8080 --db runs.sqlite
tdg dev --max-concurrent-lanes 5
bunx wrangler deploy
celld deploy --config celld.jsonc --bucket s3://actors
```

The [Celld deployment guide](celld.md) covers fleet storage, Worker variables, and the current Code Mode constraint.
