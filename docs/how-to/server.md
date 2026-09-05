# HTTP server

An HTTP server over a durable SQLite log. It holds threads, runs the actor, and serves what the actor declares.

## Run it

```bash
bun run dev
```

Bun 1.4 or later. `GET /healthz` answers once it is up.

## Endpoints

Base path `/v1`. Runtime routes address the actor mounted at the server origin. Control routes manage the actors available to a host.

| | |
| --- | --- |
| `GET /v1/providers` | Search and page provider setup requirements. The page reports the host model policy and default. `availability`, `search`, `cursor`, `limit` |
| `GET /v1/models` | Search and page public model metadata. The page reports the host model policy and default. `availability`, `provider`, `search`, `sort`, `order`, `unpriced`, `cursor`, `limit` |
| `GET /v1/metadata` | Read the mounted actor name and storage metadata |
| `GET /v1/methods` | List methods with standalone input and output schemas |
| `GET /v1/threads` | List threads |
| `PUT /v1/threads/{id}/methods/{method}/calls/{call}` | Call a method with its input as the body |
| `GET /v1/threads/{id}/methods/{method}/calls/{call}` | Read a method call's derived state |
| `PUT /v1/actors/{id}/threads/{thread}/deletion-seal` | Seal one method's admission and request cancellation of its unsettled calls |
| `POST /v1/threads/{id}/events` | Append an event, creating the thread if new |
| `GET /v1/threads/{id}/events` | Read the log. `after`, `limit`, `types` |
| `GET /v1/threads/{id}/events/stream` | Follow the log. Server-sent events resume from `Last-Event-ID` |
| `GET /v1/actors/{actor}/threads/{id}/inference/stream` | Follow transient model text produced after the connection opens |
| `GET /v1/threads/{id}/projections/{projection}` | Read a projection the mounted actor declares |
| `GET /v1/threads/{id}/tree` | Read the spawn family |
| `GET /v1/actors` | List actors available to the host |
| `PUT /v1/actors` | Push an actor artifact to the host |
| `GET /healthz` `GET /openapi.json` `GET /docs` | Unversioned |

```bash
curl -X PUT localhost:4242/v1/threads/inv-81/methods/message/calls/m1 \
  -H 'content-type: application/json' \
  -d '{"text":"audit the deploy"}'
# {"thread":"inv-81","method":"message","call":"m1"}

curl localhost:4242/v1/threads/inv-81/methods/message/calls/m1
# {"status":"completed","output":"…"}
```

A deletion seal closes one method's admission on one thread. `PUT /v1/actors/{id}/threads/{thread}/deletion-seal` records a `MethodSealed` event and requests cancellation of the method's unsettled calls and their linked descendants, answering `pending` while any cancellation is still owed and `drained` when nothing is. Admission after the seal answers 409 `method-sealed`; the refusal is decided inside the store's append transaction, so a call racing the seal never commits.

Calling a method is the application ingress. The caller chooses the thread and call ids, and the method schema validates the body. Repeating the same call URL is absorbed by the log.

Appending is the lower-level ingress for channels and interventions. The host atomically records `ThreadCreated` before the first delivered event. A spawned child records its parent address and depth in that creation event, so the tree survives changes to thread naming.

Reads are projections of the log, so `?at=<seq>` answers as of that point in history.

## Errors

Declared request failures are `application/problem+json`.

```json
{ "type": "https://tardigrade.dev/problems/unknown-thread",
  "title": "Unknown Thread", "status": 404,
  "detail": "No thread named \"ghost\" has ever existed." }
```

`unknown-projection` lists what the actor declares. `invalid-request` names the field it refused. An unexpected storage failure returns 500. The client asks the operator to inspect the actor host logs. For the compatibility `tdg dev` command, it also asks the operator to check that the project directory and `.tardigrade/actor.sqlite` still exist before restarting the server.

## Configuration

| | |
| --- | --- |
| `PORT` | `4242` |
| `TARDIGRADE_DB` | `.tardigrade/actor.sqlite` |
| `TARDIGRADE_MAX_CONCURRENT_THREADS` | Maximum actor threads settled at once. Defaults to `4` |
| `TARDIGRADE_TOKEN` | Unset. When set, runtime and control routes need `Authorization: Bearer`. `/healthz`, `/v1/providers`, `/v1/models`, `/openapi.json`, and `/docs` stay public |
| `TARDIGRADE_CONFIG_PATH` | `wrangler.jsonc`. Project and platform configuration for a directly hosted server |
| `TARDIGRADE_MODEL_CATALOG_URL` | `https://models.dev/api.json`. Source for the public model catalog |
| `TARDIGRADE_MODEL_CATALOG_CACHE` | `.tardigrade/models.json`. Last validated public snapshot |
| `TARDIGRADE_MODEL_CATALOG_TIMEOUT_MILLIS` | `10000`. Startup refresh timeout |
| Provider credentials | Set each variable named by a provider's `env` list. Use deployment secrets on a hosted server |

The server boots without a provider connection and serves every read; turns fail naming what is missing. A `models` block with provider connections requires `allow` and `default`. The default must name a configured provider and belong to the allowed set. `allow` accepts `"*"` or provider selectors. Actors inherit this complete policy and may narrow its coordinates or select another allowed default. Interactive `tdg setup` writes provider configuration under `vars.TARDIGRADE_CONFIG` in the generated platform manifests and local credentials to `.dev.vars`. Its declarative form accepts `--provider`, `--provider-config`, and `--default-model` together. The CLI writes the first provider and default atomically. Once the host has a valid baseline, the `provider` and `default` subcommands update either concern while preserving runnable configuration.

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
OPENROUTER_API_KEY='your-deployment-secret'
```

The generated `bun run dev` script reads local credentials from `.dev.vars`. A hosted process reads the same credential names from its platform secret store. The manifest contains names such as `OPENROUTER_API_KEY`, never their values.

The server refreshes the public model catalog when it starts, validates the complete provider and model listing, and replaces the cache atomically. A failed refresh serves the last valid snapshot for the configured source with `status: "cached"`. The server keeps the resolved snapshot in memory, so model resolution and catalog requests do not read the cache file on each request. With no valid source or cache, both catalog endpoints answer 503. Provider credentials never appear in either response.

Catalog responses use cursor pagination. They include `revision`, `status`, `refreshed_at`, `total`, `limit`, `items`, and optional `next_cursor`. The default limit is `50` and callers can state another positive integer. Search is a case-insensitive substring over IDs and names. `GET /v1/models` also accepts an exact provider filter. Pass `next_cursor` with the same filters to continue. A cursor records the catalog revision and query, so a changed revision or filter returns 400 and the caller starts again without a cursor.

## Live inference output

The server publishes normalized model text at `GET /v1/actors/{actor}/threads/{thread}/inference/stream`. The SSE connection carries output produced after it opens and does not replay. Each delta names the actor, instance, thread, turn, logical attempt, physical provider request, model, text block, and sequence. `makeActorClient().followInference(...)` opens the stream for a public thread ID.

An embedded Bun host can pass `inferenceObserver` to `layerThreads` for another WebSocket, Redis, pub/sub, or telemetry transport.

```ts
import { Effect } from "effect"
import { layerThreads } from "tardie/server/host"

const threads = layerThreads({
  inferenceObserver: {
    policy: { bufferCapacity: 128, deliveryTimeoutMs: 250 },
    onDelta: (delta) => Effect.promise(() => liveOutput.publish(delta))
  }
})
```

The observer queue drops new deltas when it is full. Each accepted delivery has the configured timeout. Each SSE connection also drops unread frames past `inferenceBufferCapacity`, which defaults to the exported `DEFAULT_INFERENCE_STREAM_BUFFER_CAPACITY`. Observer failure, timeout, and dropped deltas leave inference and the durable event log unchanged. A completed or failed turn remains authoritative. Replaying settled history emits no deltas. A recovery call that opens a new provider stream uses a fresh `physicalAttempt` under the same durable `logicalAttempt`. `DEFAULT_INFERENCE_OBSERVER_POLICY` exports the observer queue and timeout defaults.

## Clients

`tardie/client` is generated from the same declaration this server implements, so `/openapi.json` and the client cannot drift from it.

```ts
import { agentMethods } from "tardie"
import { makeActorClient } from "tardie/client"

const client = makeActorClient({ baseUrl: "http://localhost:4242", methods: agentMethods })
const invocation = await client.call("main", "inv-81", "message", {
  id: "m1",
  input: { text: "audit the deploy" },
  timeoutMs: 30_000
})

await client.cancel(invocation, { id: "stop-m1", reason: "the deploy finished" })
const state = await client.state(invocation)
```

`invoke` returns the actor, thread, method, call ID, and absolute deadline as one durable handle. `state` and `cancel` accept that handle. Execution epochs remain an internal fence, and each operation resolves the active epoch for the logical call. `methods` reports whether each method is cancellable and the maximum timeout it declares.
