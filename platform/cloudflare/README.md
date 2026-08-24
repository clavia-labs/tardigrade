# Cloudflare platform

This binding mounts one actor definition into a named SQLite Durable Object. The object stores its event logs, workspace, and last valid model catalog snapshot. Every thread is a lane in the actor's event table. Each accepted event commits its log append and watchdog before reconciliation starts. One alarm recovers ready lanes after an interrupted drive. Code mode uses the `LOADER` Dynamic Worker binding. Generated code runs in a fresh Worker with direct network access disabled and calls host packages through an RPC capability.

Celld implements the Worker, SQLite Durable Object, alarm, and Worker Loader surfaces this binding uses. Code Mode uses JSON replay on Celld because its loaded Worker environment cannot carry capability stubs. The [Celld deployment guide](../../docs/how-to/celld.md) covers the generated manifest and node configuration.

## Verify and deploy

```bash
bun run --cwd platform/cloudflare typecheck
bun run --cwd platform/cloudflare test
bun run --cwd platform/cloudflare test:workers
bun run --cwd platform/cloudflare bundle
bun run --cwd platform/cloudflare deploy
```

Set authentication before using the event API:

```bash
cd platform/cloudflare
bunx wrangler secret put TARDIGRADE_TOKEN
```

Store each provider credential as a Wrangler secret:

```bash
cd platform/cloudflare
bunx wrangler secret put OPENAI_API_KEY
```

Set `TARDIGRADE_CONFIG.models` under `vars` in `wrangler.jsonc`. The visible configuration names the default model reference, provider routes, and credential variable names:

```jsonc
{
  "vars": {
    "TARDIGRADE_CONFIG": {
      "models": {
        "default": { "provider": "openai", "model_id": "gpt-5.2" },
        "providers": {
          "openai": {
            "baseUrl": "https://api.openai.com/v1",
            "protocol": "openai-responses",
            "env": ["OPENAI_API_KEY"]
          }
        }
      }
    }
  }
}
```

A host without model configuration records a failed turn that names the missing configuration. The Worker validates the public catalog from models.dev, stores the last valid snapshot in the actor object, and loads it into isolate memory. Provider connections and secrets stay outside the catalog.

## HTTP shapes

`GET /healthz`, `GET /v1/providers`, and `GET /v1/models` are public. The catalog routes return paginated views of the validated snapshot from isolate memory.

```json
{ "status": "resting", "dirty": 0 }
```

Every method and thread endpoint requires `Authorization: Bearer <TARDIGRADE_TOKEN>`. A host without `TARDIGRADE_TOKEN` returns status `503` with `{ "error": "authentication is not configured" }`. An incorrect token returns status `401` with `{ "error": "unauthorized" }`.

`GET /v1/methods` returns the input and output schema for each callable method on the mounted actor.

`GET /v1/threads` has no input body and returns each durable thread with its event count.

```json
[{ "id": "root", "events": 5 }]
```

`POST /v1/threads/{thread}/events` accepts an event object. A root message has this shape:

```json
{ "type": "MessageReceived", "id": "m1", "text": "Research sauna safety." }
```

The response has status `202` and identifies the accepted destination.

```json
{ "thread": "root" }
```

`GET /v1/threads/{thread}/events` accepts `after`, `limit`, and comma-separated `types` query parameters. It returns sequence numbers beside the stored events.

```json
[
  { "seq": 1, "event": { "type": "ThreadCreated", "thread": "root", "depth": 0 } },
  { "seq": 2, "event": { "type": "MessageReceived", "id": "m1", "text": "Research sauna safety." } }
]
```

## Configuration

| Name | Default | Effect |
| --- | --- | --- |
| `TARDIGRADE_TOKEN` | unset | Protects every endpoint except `/healthz`; an unset value closes the event API |
| `TARDIGRADE_MAX_CONCURRENT_LANES` | `4` | Limits lanes settled concurrently inside one actor object |
| `TARDIGRADE_ALARM_DELAY_MILLIS` | `120000` | Sets the watchdog delay for an interrupted actor drive |
| `TARDIGRADE_COMPACTION_FIRE_RATIO` | `0.8` | Compacts when rendered context crosses this fraction of the selected model window |
| `TARDIGRADE_COMPACTION_KEEP_RATIO` | `0.5` | Keeps this fraction of the selected model window verbatim after compaction |
| `TARDIGRADE_MODEL_CATALOG_URL` | `https://models.dev/api.json` | Selects the public model catalog source |
| `TARDIGRADE_MODEL_CATALOG_LOAD_POLICY` | `refresh` | Uses `refresh` to fetch once per isolate or `cache-first` to prefer the actor snapshot |
| `TARDIGRADE_MODEL_CATALOG_TIMEOUT_MILLIS` | `10000` | Bounds a catalog refresh request |
| `TARDIGRADE_SANDBOX_LOG_CAP_BYTES` | `8192` | Limits the captured console output returned to code mode |
| `TARDIGRADE_SANDBOX_CPU_MILLIS` | Cloudflare default | Sets the Dynamic Worker CPU limit |
| `TARDIGRADE_SANDBOX_SUBREQUESTS` | Cloudflare default | Sets the Dynamic Worker subrequest limit |
| `TARDIGRADE_CONFIG` | `{}` | Supplies provider connections and the default model reference as visible JSON configuration in `wrangler.jsonc` |
| `TARDIGRADE_SANDBOX_TRANSPORT` | `capability` | Selects direct capability calls or deterministic JSON `replay` for loaded Workers |

`wrangler.jsonc` also makes the Dynamic Worker Loader binding, Worker CPU limit, and Durable Object migration visible. Change those values in the deployment configuration when the account or workload requires a different policy. `DEFAULT_CLOUDFLARE_SANDBOX_POLICY` exposes the Dynamic Worker compatibility date, compatibility flags, console cap, outbound policy, and transport. `layerCloudflareSandbox` accepts overrides for each value.
