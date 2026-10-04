# Run and deploy

## Wire the same graph to different hosts

```text
actor.ts       methods + atoms + library contracts
    |
services.ts    model providers + library handlers + storage capabilities
    |
    +--> server.ts --> Bun host --> SQLite journals
    |
    +--> worker.ts --> ActorDO --> Durable Object storage
```

Keep I/O in service implementations. `actorContext` exposes model metadata and tool contracts during construction; it does not expose executable handlers. `createBunHost` mounts the definition with execution services; `createActorWorker` exports the Cloudflare Worker and separate supervisor and thread DO classes. `methodHttp(host, { token? })` exposes invocation, result polling, cancellation, and recorded events using the mounted actor's contracts. Discovery inspects actor setup in a temporary in-memory runtime without executing proposals or allocating durable threads; invocation routes read the target thread's contracts. `tdg lint` validates the atom definition and reports that its methods are validated during setup.

For models, wire `modelInfo` and `modelActs` to `liveModelServices`, using provider configuration, `modelCredentialsFrom`, and the committed `models.lock.json`. Use the explicit provider layer import from `tardie/model/providers/<provider>` in bundled applications; do not assume a dynamic provider loader is included by a Worker bundler. The generated `services.ts` shows this wiring.

Tool contracts and implementations must match. Supply `toolActs([implementation])` for direct tools. Code mode needs `codeModeActs` and a platform-appropriate isolate; inspect the [CLI actor services](../../../packages/apps/cli/src/services.ts) when adding it. Declaring `codeMode` alone does not install a sandbox.

## Create and run a CLI project

Use Bun 1.4 or later. For an installed release:

```sh
bun add -g tardie@latest
tdg init research-agent --template quickstart
cd research-agent
bun install
tdg lint actor.ts
tdg build actor.ts
bun run dev
```

The quickstart creates an atom actor with its method declarations, `services.ts`, Bun and Worker entries, provider configuration, and a model lock. It includes an example weather tool returning fixed sample data; replace that handler for actual weather. The RLM template uses component APIs, so select templates intentionally.

For noninteractive initialization, choose a tool-capable model available to the provider and pass its actual ID:

```sh
MODEL_ID='your-provider-model-id'
tdg init research-agent --template quickstart \
  --provider openrouter \
  --provider-config '{"protocol":"openai-chat-completions","baseUrl":"https://openrouter.ai/api/v1","env":["OPENROUTER_API_KEY"]}' \
  --default-model "$MODEL_ID"
```

Supply the credential named in configuration through the process environment or `.dev.vars`. Keep secret files untracked and avoid printing their contents. If an execution environment strips inherited credentials, verify presence inside the server environment rather than assuming the parent process proves availability.

In a second terminal, from the project directory:

```sh
tdg methods --json
tdg thread create --name smoke --json
tdg call message '{"text":"Use the weather tool for Singapore."}' \
  --thread smoke --id smoke-1 --json
tdg events smoke --json
tdg call message '{"text":"Which city did I ask about?"}' \
  --thread smoke --id smoke-2 --json
```

Default local port is 4242. `PORT` and `TARDIGRADE_ACTOR_DATA` configure the generated server; `--url` selects a host for CLI calls. Thread creation precedes calls with an explicit `--thread`; omitting `--thread` allocates a root. The root's registry and per-thread event databases are separate, so preserve both when backing up Bun storage.

## Check the durability boundary

```text
same thread + same method + same ID + same input
                        |
                        v
                  saved invocation

same identity + changed input --> conflict
new ID                         --> new invocation
```

Use a caller-stable ID for retries. Repeat a completed call with exactly the same input and ID, then compare logs: the retry should return the saved result without new events or model work. An HTTP 202 is acceptance; inspect the terminal method state before reporting success.

`tdg call` waits by default. `--timeout` limits the CLI's wait; it does not cancel durable work or install an invocation deadline. Use `tdg call cancel --help` for the cancellation syntax supported by the installed CLI, and inspect the terminal result afterward.

The atom `methodHttp` surface supports method discovery, creation, invocation, state polling, cancellation, and event inspection. It does not implement every legacy CLI route, including legacy listing and SSE streaming. Check endpoint support before reusing component-host commands.

## Deploy to Cloudflare

Check authentication and the intended account:

```sh
bunx wrangler whoami
```

Inspect `wrangler.jsonc`: unique Worker name, `worker.ts` entry, `nodejs_compat`, `ACTORS` binding to `ActorDO`, and a migration with `new_sqlite_classes: ["ActorDO"]`. This quickstart uses Durable Object SQLite storage and needs no D1 catalog. Set `account_id` when account selection is ambiguous. For an existing deployment, retain migration history and existing class identities.

Set the configured provider credential as a Worker secret. A local environment variable does not become a deployed secret:

```sh
bunx wrangler secret put OPENROUTER_API_KEY
bun run deploy:cloudflare
```

The deploy script uses `bunx wrangler deploy`, so it does not require a global Wrangler install. Worker configuration may deliver `TARDIGRADE_CONFIG` as an object or JSON string; preserve the template's handling of both when adapting it.

Use the URL Wrangler returns:

```sh
ACTOR_URL='https://your-worker.your-subdomain.workers.dev'
tdg methods --url "$ACTOR_URL" --json
tdg thread create --name cloud-smoke --url "$ACTOR_URL" --json
tdg call message '{"text":"Use the weather tool for Singapore."}' \
  --thread cloud-smoke --id cloud-smoke-1 --url "$ACTOR_URL" --json
tdg events cloud-smoke --url "$ACTOR_URL" --json
```

Set `TARDIGRADE_TOKEN` on the Worker when the endpoint requires authentication; CLI requests use `--token` or the local `TARDIGRADE_TOKEN` environment variable. Provision authentication appropriate to the intended exposure.

For a complete authorized smoke test, verify real model and tool results, a context-dependent follow-up, an identical retry with unchanged history, and a saved result after restart or redeploy. Use a uniquely named temporary Worker for disposable tests; remove that Worker, test data, and temporary credential files afterward. Never delete a shared deployment as test cleanup. Stop blind retries on authentication, billing, or provider configuration failures and diagnose the cause.

## Diagnose by the last recorded transition

| Symptom | Inspect |
| --- | --- |
| Missing credential | Provider `env` names, server environment, deployed Worker secrets |
| Tool absent during setup | Selected contracts and the host's `ToolCatalog` |
| Unknown library or method | Matching names in declarations and execution implementations |
| Provider rejects tool schema | Final model-facing JSON Schema, object payload, required fields, references |
| `ModelFailed` | Recorded reason, provider response, model availability, credentials |
| `ToolCalled` without a successful result | Handler dependencies, `ToolReturned.error`, execution state |
| Method remains pending | Invocation ID correlation, settlement events, `result` projection |
| Repeated event proposals | Whether recorded state causes the producer to withdraw its proposal |
| Missing `effect/process` or `effect/socket` module | Resolved Effect and platform versions, including nested dependencies |
| Worker bundles locally but fails remotely | Explicit provider imports, Worker-compatible services, runtime bindings |

The project pins an Effect v4 release candidate with matching platform and SQL packages. Stable Effect v4 can change provider APIs. Inspect provider peer dependencies before upgrading; keep the scaffold's transitive version overrides while the release candidate is in use. Avoid fixing an import error by mixing Effect generations.

## Test the delivered artifact

Fixture tests establish protocol behaviour; real inference establishes provider integration; Cloudflare deployment establishes bundling and platform wiring. Report each separately. The weather example's sample output validates tool execution, not actual weather accuracy.

For SDK packaging changes, pack the checkout and run the installed tarball's CLI in a standalone temporary project. Substitute only the `tardie` dependency with the local tarball path before installation. A workspace-linked test can hide missing templates, exports, dependency conflicts, and undeclared executables. In this repository:

```sh
bun run tools/publish.ts --pack-only --output .context/skill-smoke-package
```

Use the tarball printed by that command; no npm publication is needed. Follow focused tests and checks for changed active packages. The published `tdg` implementation is in `apps/cli` even though its package name contains `deprecated`; distinguish that from gates devoted to deprecated component libraries.
