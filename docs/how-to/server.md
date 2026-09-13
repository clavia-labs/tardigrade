# HTTP server

An HTTP server over a durable SQLite log. It holds threads, runs the actor, and serves what the actor declares.

## Run it

```bash
bun run dev
```

Bun 1.4 or later. `GET /healthz` answers once it is up.

## Endpoints

Base path `/v1`. Runtime routes address instances of the actor mounted at the server origin. In paths below, `{instance}` identifies an actor instance. Control routes manage actor definitions available to a host.

| | |
| --- | --- |
| `GET /v1/providers` | Search and page provider setup requirements. The page reports the host model policy and default. `availability`, `search`, `cursor`, `limit` |
| `GET /v1/models` | Search and page public model metadata. The page reports the host model policy and default. `availability`, `provider`, `search`, `sort`, `order`, `unpriced`, `cursor`, `limit` |
| `GET /v1/metadata` | Read the mounted actor name and storage metadata |
| `GET /v1/methods` | List methods with standalone input and output schemas |
| `GET /v1/actors/{instance}/threads` | List threads. `root`, `maxDepth`, `maxNodes` bound what the listing builds |
| `PUT /v1/actors/{instance}/threads/{thread}/methods/{method}/calls/{call}` | Call a method with its input as the body |
| `GET /v1/actors/{instance}/threads/{thread}/methods/{method}/calls/{call}` | Read a method call's derived state |
| `POST /v1/actors/{instance}/threads` | Allocate a root thread with an optional `name` or retry `key` |
| `POST /v1/actors/{instance}/threads/{thread}/events` | Append an event to an allocated thread |
| `GET /v1/actors/{instance}/threads/{thread}/events` | Read the log. `after`, `limit`, `types` |
| `GET /v1/actors/{instance}/threads/{thread}/events/stream` | Follow the log. Server-sent events resume from `Last-Event-ID` |
| `GET /v1/actors/{instance}/threads/{thread}/inference/stream` | Follow transient model text produced after the connection opens |
| `GET /v1/actors/{instance}/threads/{thread}/projections/{projection}` | Read a projection the mounted actor declares |
| `GET /v1/actors/{instance}/threads/{thread}/tree` | Read the spawn family. `maxDepth`, `maxNodes` bound what the tree builds |
| `GET /v1/actors` | List actor instances |
| `GET /v1/definitions` | List actor definitions available to the host |
| `PUT /v1/definitions` | Push an actor artifact to a host with a writable definition registry |
| `GET /healthz` `GET /openapi.json` `GET /docs` | Unversioned |

Bun HTTP hosts and Cloudflare Worker HTTP handlers serve Scalar at `/docs` and the OpenAPI document at `/openapi.json`. Each document describes its host's declared routes. Method calls use a generic payload in OpenAPI; `GET /v1/methods` provides the mounted actor's input and output schemas. An actor used in-process exposes no HTTP routes until a host serves it.

```bash
curl -X POST localhost:4242/v1/actors/main/threads \
  -H 'content-type: application/json' \
  -d '{"name":"inv-81"}'

curl -X PUT localhost:4242/v1/actors/main/threads/inv-81/methods/message/calls/m1 \
  -H 'content-type: application/json' \
  -d '{"text":"audit the deploy"}'
# 202 Accepted; Location points to the call state

curl localhost:4242/v1/actors/main/threads/inv-81/methods/message/calls/m1
# {"status":"completed","output":"…"}
```

Calling a method is the application ingress. Allocate a thread first, then use its assigned ID and a stable call ID. The method schema validates the body. Repeating the same call URL is absorbed by the log. A successful submission returns `202 Accepted`; poll its `Location` until the state is `completed`, `failed`, or `cancelled`.

Appending is the lower-level ingress for channels and interventions on an existing thread. Allocation records `ThreadCreated` before application events. A spawned child records its parent address and depth in that creation event, so the tree survives changes to thread naming.

The events endpoint pages through the log with `after`, `limit`, and `types`. Custom projection endpoints accept the query fields declared by their projection schemas.

## Errors

Declared request failures are `application/problem+json`.

```json
{ "type": "https://tardigrade.dev/problems/unknown-thread",
  "title": "Unknown Thread", "status": 404,
  "detail": "No thread named \"ghost\" has ever existed." }
```

`unknown-projection` lists what the actor declares. `invalid-request` names the field it refused. An unexpected storage failure returns 500. The client asks the operator to inspect the actor host logs.

## Configuration

| | |
| --- | --- |
| `PORT` | `4242` |
| `TARDIGRADE_ACTOR_DATA` | `.tardigrade/data`. Instance storage directory used by generated Bun servers |
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

The Effect inference binding accepts request settings at `providers.<provider>.models.<model_id>.options`:

```jsonc
"models": {
  "gpt-5": {
    "options": { "reasoning": { "effort": "high" } }
  }
}
```

Place `models` beside the provider's `baseUrl`, `protocol`, and `env`. These entries configure requests; `default` and `allow` still control selection and access. Missing options preserve provider defaults. The host's `configure` callback overrides configured options by top-level field.

| Protocol | Options |
| --- | --- |
| `openai-responses` | `reasoning: { effort: "high" }` |
| `openai-chat-completions` | `reasoning_effort: "high"` |
| `anthropic-messages` | `thinking: { type: "adaptive" }`, `output_config: { effort: "high" }` |
| `bedrock-converse` | `additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: 1024 } }` |

OpenAI Responses also accepts native reasoning summary settings. Anthropic accepts adaptive, disabled, or enabled thinking; enabled thinking requires at least 1024 budget tokens. The installed Effect version accepts Anthropic effort values `low`, `medium`, `high`, or `null`. Providers validate support for the selected model. Bedrock's additional fields are provider-specific JSON and follow the selected model's request contract.

Built-in Bun and Worker model services apply these settings through Effect `modelLayer`. Regenerate the model lock after changing provider configuration.

The server refreshes the public model catalog when it starts, validates the complete provider and model listing, and replaces the cache atomically. A failed refresh serves the last valid snapshot for the configured source with `status: "cached"`. The server keeps the resolved snapshot in memory, so model resolution and catalog requests do not read the cache file on each request. With no valid source or cache, both catalog endpoints answer 503. Provider credentials never appear in either response.

Catalog responses use cursor pagination. They include `revision`, `status`, `refreshed_at`, `total`, `limit`, `items`, and optional `next_cursor`. The default limit is `50` and callers can state another positive integer. Search is a case-insensitive substring over IDs and names. `GET /v1/models` also accepts an exact provider filter. Pass `next_cursor` with the same filters to continue. A cursor records the catalog revision and query, so a changed revision or filter returns 400 and the caller starts again without a cursor.

## Live inference output

The server publishes normalized model text at `GET /v1/actors/{instance}/threads/{thread}/inference/stream`. The SSE connection carries output produced after it opens and does not replay. Each delta names the actor, instance, thread, turn, logical attempt, physical provider request, model, text block, and sequence. `makeActorClient().followInference(...)` opens the stream for a public thread ID.

For another WebSocket, Redis, pub/sub, or telemetry transport, supply an observer through `modelLayer(config, snapshot, { observer })` when composing model services:

```ts
import { Effect } from "effect"
import type { InferenceObserver } from "tardie/agent"

const observer: InferenceObserver = {
  policy: { bufferCapacity: 128, deliveryTimeoutMs: 250 },
  onDelta: (delta) => Effect.sync(() => console.log(delta))
}
```

Replace the logging handler with your transport. `makeInferenceStream(observer)` from `tardie/http/inference-stream` combines this observer with an HTTP stream; pass its `observer` to `modelLayer` and the stream as `api.inference` to `serve`. The `bunModelServices` helper supplies the HTTP stream for the standard setup.

The observer queue drops new deltas when it is full. Each accepted delivery has the configured timeout. Each SSE connection also drops unread frames past `inferenceBufferCapacity`, which defaults to the exported `DEFAULT_INFERENCE_STREAM_BUFFER_CAPACITY`. Observer failure, timeout, and dropped deltas leave inference and the durable event log unchanged. A completed or failed turn remains authoritative. Replaying settled history emits no deltas. A recovery call that opens a new provider stream uses a fresh `physicalAttempt` under the same durable `logicalAttempt`. `DEFAULT_INFERENCE_OBSERVER_POLICY` exports the observer queue and timeout defaults.

The inference binding fails a turn with `output_limit` when the provider exhausts its output allowance. It records reported usage and executes no tools from the truncated response. It does not retry with a higher limit. Direct bindings accept `maxOutputTokens` and otherwise use the native configuration or `DEFAULT_MAX_OUTPUT_TOKENS` from `tardie/model/request-policy`. The default is 32,768 tokens.

## Clients

`tardie/client` is generated from the same declaration this server implements, so `/openapi.json` and the client cannot drift from it.

```ts
import { agentMethods } from "tardie/agent"
import { makeActorClient } from "tardie/client"

const client = makeActorClient({ baseUrl: "http://localhost:4242", methods: agentMethods })
const thread = await client.allocateRoot("main", "inv-81")
const invocation = await client.call(thread.instance, thread.thread, "message", {
  id: "m1",
  input: { text: "audit the deploy" },
  timeoutMs: 30_000
})

await client.cancel(invocation, { reason: "the deploy finished" })
const state = await client.state(invocation)
```

`call` returns the actor, thread, method, call ID, and absolute deadline as one durable handle. `state` and `cancel` accept that handle. Execution epochs remain an internal fence, and each operation resolves the active epoch for the logical call. `methods` reports whether each method is cancellable and the maximum timeout it declares.
