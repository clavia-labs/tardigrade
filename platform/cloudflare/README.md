# Cloudflare platform

This binding mounts each actor in an `ActorDO` and each thread in a `ThreadDO`. The Actor DO stores the actor identity, model catalog, and thread directory. Each Thread DO stores one event log, one workspace, and one alarm lifecycle. Each accepted event commits its log append and recovery alarm before reconciliation starts. The alarm covers interrupted drives and the earliest unresolved method deadline. Code mode uses the `LOADER` Dynamic Worker binding. Generated code runs in a fresh Worker with direct network access disabled and calls host packages through an RPC capability.

Celld implements the Worker, SQLite Durable Object, alarm, and Worker Loader surfaces this binding uses. Code Mode uses JSON replay on Celld because its loaded Worker environment cannot carry capability stubs. The [Celld deployment guide](../../docs/how-to/celld.md) covers the generated manifest and node configuration.

## Thread isolation

Each actor thread has a separate Thread DO, SQLite database, driver, alarm lifecycle, and isolate heap. The object name derives from the actor definition and thread identity. Actor delivery uses the complete `ThreadAddress`, so a child thread routes to its own Thread DO when it uses the same actor definition.

```ts
export { ActorDO, ThreadDO }
export default cloudflareWorker(definition)
```

The standard Durable Object adapter supports `independent` placement. Pass `defaultChildPlacement: "independent"` to state the default explicitly. A request for `colocated` placement fails because ordinary Durable Object namespaces cannot guarantee it. A future Facets adapter can advertise `colocated` placement without changing the actor or thread contracts.

The Actor DO keeps a routing and query directory with each thread's parent, depth, and placement. `GET /v1/threads` reads that directory, then reads each Thread DO log to build the tree. Thread-specific method and event routes select the matching Thread DO.


## Application services

An actor can require an application Effect service. Pass `layersFor` to `cloudflareWorker` to build that service from the Worker environment and current thread. Tardigrade merges the returned layer with its model, HTTP, sandbox, event-log, and workspace layers. It constructs the application layer separately for each thread settlement, so mutable service state is shared only when the supplied Layer explicitly shares it.

```ts
import { Context, Effect, Layer } from "effect"
import { ActorDO, ThreadDO, cloudflareWorker, type CloudflareWorkerLayerContext, type Env as TardigradeEnv } from "tardie/cloudflare"

interface Env extends TardigradeEnv {
  readonly CUSTOMERS: D1Database
}

class CustomerStore extends Context.Service<
  CustomerStore,
  { readonly find: (id: string) => Effect.Effect<unknown> }
>()("application/CustomerStore") {}

export { ActorDO, ThreadDO }
export default cloudflareWorker(definition, {
  layersFor: ({ env, thread }: CloudflareWorkerLayerContext<Env>) => Layer.succeed(CustomerStore, {
    find: id => Effect.promise(() => env.CUSTOMERS.prepare("SELECT * FROM customers WHERE thread = ? AND id = ?").bind(thread, id).first())
  })
})
```

The callback may require Tardigrade's thread ports while constructing its layer. The returned Layer has a `never` error channel.

## Thread creation

Create an actor instance, then create each root thread through its Actor DO before writing events to the Thread DO. Creation is idempotent. It records the thread in the actor directory and initializes the Thread DO identity. Later event appends and method calls address the Thread DO directly. An unknown thread returns `404`.

```ts
await fetch("/v1/actors/customer-42", { method: "PUT", headers })
await fetch("/v1/actors/customer-42/threads/conversation-7", { method: "PUT", headers })
await fetch("/v1/actors/customer-42/threads/conversation-7/events", {
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify({ type: "MessageReceived", id: "message-1", text: "Hello" })
})
```

## Event store policy

Pass `storeFor` to set each thread's event store policy. The callback receives the Worker environment and thread identity, then returns `wrap` for event bodies and `indexKey` for event keys. Host ingress, reactor appends, API reads, recovery, deadlines, and alarms use the policy. Encryption and key management remain application concerns.

The wrapper must preserve the `ThreadEventStore` append order, atomic batch, deduplication, watermark, and ordered-tail guarantees. `hmacSha256EventKeyIndex` creates a deterministic thread-bound HMAC index that hides identifiers stored in event keys. Give it HMAC key material separate from any body encryption key. Omitting `storeFor` uses the SQLite store and plaintext event keys directly.

## Model adapters

The Worker registers the protocol implementations its configured providers use. Each adapter is a separate import, so a bundle includes its provider library only when the Worker selects it. Host startup fails with the missing protocol and a registration instruction when configuration names an unregistered protocol.

```ts
import { ActorDO, ThreadDO, cloudflareWorker } from "tardie/cloudflare"
import { modelAdapters } from "tardie/model/adapter"
import { anthropicAdapter } from "tardie/model/anthropic"

export { ActorDO, ThreadDO }
export default cloudflareWorker(definition, {
  modelAdapters: modelAdapters(anthropicAdapter)
})
```

Register several adapters when the host configures providers with several protocols:

```ts
import { anthropicAdapter } from "tardie/model/anthropic"
import { openAICompatibleAdapter } from "tardie/model/openai"

modelAdapters(anthropicAdapter, openAICompatibleAdapter)
```

Amazon Bedrock is an optional peer dependency. Install its provider packages and register `bedrockAdapter` from `tardie/model/bedrock` when the host uses `bedrock-converse`.

## Live inference output

Pass `inferenceObserverFor` to observe normalized text while a provider stream is active. The factory receives the Worker environment and thread, so delivery can use a deployment binding. Deltas are ephemeral and carry actor, thread, turn, logical attempt, physical attempt, model, block, sequence, and text identity.

```ts
import { Effect } from "effect"
import { ActorDO, ThreadDO, cloudflareWorker, type CloudflareWorkerLayerContext, type Env as TardigradeEnv } from "tardie/cloudflare"

interface Env extends TardigradeEnv {
  readonly LIVE_OUTPUT: Queue
}

export { ActorDO, ThreadDO }
export default cloudflareWorker(definition, {
  modelAdapters: modelAdapters(anthropicAdapter),
  inferenceObserverFor: ({ env }: CloudflareWorkerLayerContext<Env>) => ({
    onDelta: (delta) => Effect.promise(() => env.LIVE_OUTPUT.send(delta))
  })
})
```

Observer delivery uses the exported `DEFAULT_INFERENCE_OBSERVER_POLICY`. Supply `policy.bufferCapacity` and `policy.deliveryTimeoutMs` on the returned observer to override it. A full queue drops new deltas. Observer failure and timeout leave inference unchanged. The durable terminal event remains authoritative, and replaying settled history emits no deltas.

## Verify and deploy

```bash
bun run --cwd platform/cloudflare typecheck
bun run --cwd platform/cloudflare test
bun run --cwd platform/cloudflare test:workers
bun run --cwd platform/cloudflare bundle
bun run --cwd platform/cloudflare deploy
```

The [Worker Loader platform](../worker-loader/README.md) owns Code Mode sandbox policy and its shared workerd and Celld runtime tests.

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
| `TARDIGRADE_ALARM_DELAY_MILLIS` | `120000` | Sets the recovery wake delay for an interrupted actor drive |
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

`wrangler.jsonc` also makes the Dynamic Worker Loader binding, Worker CPU limit, and Durable Object migration visible. Change those values in the deployment configuration when the account or workload requires a different policy. `DEFAULT_WORKER_LOADER_SANDBOX_POLICY` exposes the Dynamic Worker compatibility date, compatibility flags, console cap, outbound policy, and transport. `layerWorkerLoaderSandbox` accepts overrides for each value.
