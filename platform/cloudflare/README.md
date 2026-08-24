# Cloudflare platform

This binding stores the actor registry in D1 and runs each registered actor graph in its named SQLite Durable Object. `@effect/sql-d1` binds the registry, `@effect/sql-sqlite-do` binds each actor object's storage, and `effect/unstable/http` serves the Worker routes. Every thread is a lane in its actor's event table. One alarm per actor drives ready lanes with the configured concurrency limit, and an alarm scheduled during an active pass remains armed after that pass. Code mode uses the `LOADER` Dynamic Worker binding. Generated code runs in a fresh Worker with direct network access disabled and calls host packages through an RPC capability.

## Verify and deploy

```bash
bun run --cwd platform/cloudflare typecheck
bun run --cwd platform/cloudflare test
bun run --cwd platform/cloudflare test:workers
bun run --cwd platform/cloudflare bundle
bun run --cwd platform/cloudflare deploy
```

Create the D1 registry before the first deployment, then place its returned `database_id` in `wrangler.jsonc` under the `REGISTRY` binding:

```bash
cd platform/cloudflare
bunx wrangler d1 create tardigrade-registry
```

Set authentication before using the event API:

```bash
cd platform/cloudflare
bunx wrangler secret put TARDIGRADE_TOKEN
```

Set `MODEL_BASE_URL`, `MODEL_API_KEY`, and `MODEL_ID` to run model turns. `MODEL_API_KEY` should be a Wrangler secret. A host without model configuration records a failed turn that names the missing configuration.

## HTTP shapes

`GET /healthz`, `GET /v1/providers`, and `GET /v1/models` are public.

```json
{ "status": "resting", "dirty": 0 }
```

Actor endpoints require `Authorization: Bearer <TARDIGRADE_TOKEN>`. A host without `TARDIGRADE_TOKEN` returns status `503` with `{ "error": "authentication is not configured" }`. An incorrect token returns status `401` with `{ "error": "unauthorized" }`.

The first catalog request in a Worker isolate refreshes models.dev and persists the validated snapshot in D1. Later requests reuse the in-memory snapshot. A failed refresh may serve the last D1 snapshot with `status: "cached"`. Both catalog endpoints accept `search`, `cursor`, and `limit`; `/v1/models` also accepts `provider`.

`GET /v1/actors` has no input body and returns the actors registered in D1. The Worker inserts its exported `DEFAULT_ACTOR_REGISTRATION` when `default` is absent.

```json
[{ "name": "default", "builtIn": true }]
```

`GET /v1/actors/default/threads` has no input body and returns each durable thread with its event count.

```json
[{ "id": "root", "events": 5 }]
```

`POST /v1/actors/default/threads/{thread}/events` accepts an event object. A root message has this shape:

```json
{ "type": "MessageReceived", "id": "m1", "text": "Research sauna safety." }
```

The response has status `202` and identifies the accepted destination.

```json
{ "actor": "default", "thread": "root" }
```

`GET /v1/actors/default/threads/{thread}/events` accepts `after`, `limit`, and comma-separated `types` query parameters. It returns sequence numbers beside the stored events.

```json
[
  { "seq": 1, "event": { "type": "ThreadCreated", "thread": "root", "depth": 0 } },
  { "seq": 2, "event": { "type": "MessageReceived", "id": "m1", "text": "Research sauna safety." } }
]
```

## Configuration

| Name | Default | Effect |
| --- | --- | --- |
| `TARDIGRADE_TOKEN` | unset | Protects actor endpoints; an unset value closes the event API |
| `TARDIGRADE_MODEL_CATALOG_URL` | `https://models.dev/api.json` | Selects the public catalog source |
| `TARDIGRADE_MODEL_CATALOG_LOAD_POLICY` | `refresh` | Uses `refresh` once per isolate or `cache-first` when a stored snapshot should win |
| `TARDIGRADE_MODEL_CATALOG_TIMEOUT_MILLIS` | `10000` | Bounds the catalog refresh |
| `TARDIGRADE_MAX_CONCURRENT_LANES` | `4` | Limits lanes settled concurrently inside one actor object |
| `TARDIGRADE_ALARM_DELAY_MILLIS` | `0` | Delays a newly armed actor alarm |
| `TARDIGRADE_COMPACTION_FIRE_RATIO` | `0.8` | Compacts when rendered context crosses this fraction of the selected model window |
| `TARDIGRADE_COMPACTION_KEEP_RATIO` | `0.5` | Keeps this fraction of the selected model window verbatim after compaction |
| `TARDIGRADE_SANDBOX_LOG_CAP_BYTES` | `8192` | Limits the captured console output returned to code mode |
| `TARDIGRADE_SANDBOX_CPU_MILLIS` | Cloudflare default | Sets the Dynamic Worker CPU limit |
| `TARDIGRADE_SANDBOX_SUBREQUESTS` | Cloudflare default | Sets the Dynamic Worker subrequest limit |
| `MODEL_BASE_URL` | unset | Selects the model API endpoint |
| `MODEL_API_KEY` | unset | Authenticates the model API request |
| `MODEL_ID` | unset | Selects the model |
| `MODEL_SONNET_ID` | `MODEL_ID` | Selects the model for `sonnet` briefs |
| `MODEL_OPUS_ID` | `MODEL_ID` | Selects the model for `opus` briefs |
| `MODEL_HAIKU_ID` | `MODEL_ID` | Selects the model for `haiku` briefs |
| `MODEL_PROVIDER` | unset | Supplies an optional provider hint |
| `MODEL_CONTEXT_WINDOW_TOKENS` | `1000000` in `wrangler.jsonc`; framework fallback `128000` | Declares the default model context window used by compaction |
| `MODEL_SONNET_CONTEXT_WINDOW_TOKENS` | default model window | Declares the `sonnet` model context window |
| `MODEL_OPUS_CONTEXT_WINDOW_TOKENS` | default model window | Declares the `opus` model context window |
| `MODEL_HAIKU_CONTEXT_WINDOW_TOKENS` | default model window | Declares the `haiku` model context window |

`wrangler.jsonc` also makes the D1 registry binding, Dynamic Worker Loader binding, Worker CPU limit, and Durable Object migration visible. Change those values in the deployment configuration when the account or workload requires a different policy. `DEFAULT_CLOUDFLARE_SANDBOX_POLICY` exposes the Dynamic Worker compatibility date, compatibility flags, console cap, and outbound policy. `layerCloudflareSandbox` accepts overrides for each value.
