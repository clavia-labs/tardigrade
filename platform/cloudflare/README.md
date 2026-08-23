# Cloudflare platform

This binding runs one actor graph in one SQLite Durable Object. `@effect/sql-sqlite-do` binds the object's full storage handle to Effect SQL, and `effect/unstable/http` serves the Worker routes. Every thread is a lane in the object's event table. One alarm drives ready lanes with the configured concurrency limit, and an alarm scheduled during an active pass remains armed after that pass.

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

Set `MODEL_BASE_URL`, `MODEL_API_KEY`, and `MODEL_ID` to run model turns. `MODEL_API_KEY` should be a Wrangler secret. A host without model configuration records a failed turn that names the missing configuration.

## HTTP shapes

`GET /healthz` is public.

```json
{ "status": "resting", "dirty": 0 }
```

Every other endpoint requires `Authorization: Bearer <TARDIGRADE_TOKEN>`. A host without `TARDIGRADE_TOKEN` returns status `503` with `{ "error": "authentication is not configured" }`. An incorrect token returns status `401` with `{ "error": "unauthorized" }`.

`GET /v1/actors` has no input body and returns the actors served by this Worker.

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
| `TARDIGRADE_TOKEN` | unset | Protects every endpoint except `/healthz`; an unset value closes the event API |
| `TARDIGRADE_MAX_CONCURRENT_LANES` | `4` | Limits lanes settled concurrently inside one actor object |
| `TARDIGRADE_ALARM_DELAY_MILLIS` | `0` | Delays a newly armed actor alarm |
| `MODEL_BASE_URL` | unset | Selects the model API endpoint |
| `MODEL_API_KEY` | unset | Authenticates the model API request |
| `MODEL_ID` | unset | Selects the model |
| `MODEL_PROVIDER` | unset | Supplies an optional provider hint |

`wrangler.jsonc` also makes the Worker CPU limit and Durable Object migration visible. Change those values in the deployment configuration when the account or workload requires a different policy.
