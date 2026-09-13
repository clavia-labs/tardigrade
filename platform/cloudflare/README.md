# Cloudflare platform

Run Tardigrade actors on Cloudflare Workers and SQLite Durable Objects. The Worker handles HTTP requests, an `ActorDO` allocates and tracks threads, and each `ThreadDO` stores and executes a thread. Celld uses the same Worker entry point.

## Worker entry point

`tdg init` generates the entry point and deployment configuration. `tdg setup` configures a model provider and writes `models.lock.json`. The provider-layer import must match the configured provider protocol. This example uses an OpenAI-compatible Chat Completions provider.

```ts
import definition from "./actor"
import { defineWorkerHost, workerHttp, workerModelServices, modelScopeFrom } from "tardie/worker"
import { providerLayer } from "tardie/model/providers/openai-compat"
import modelLock from "./models.lock.json"

const services = workerModelServices({
  model: { providerLayer },
  scope: modelScopeFrom(modelLock)
})

const host = defineWorkerHost(definition, { services })
const http = workerHttp(host)

export const { ActorDO, ThreadDO } = host
export default { fetch: http.fetch }
```

`workerModelServices` connects the configured providers to Effect AI and the catalog snapshot. `defineWorkerHost` registers the actor and exposes its Durable Object classes. `workerHttp` supplies the HTTP handler. Cloudflare calls `fetch` when a request arrives and creates object instances when they are addressed. The entry point registers one actor definition per module.

An actor that does not use model inference can omit `services`. The Worker entry point supplies its provider layer through `model.providerLayer`.

## Runtime and storage

```text
HTTP request -> Worker handler
                 +-- ActorDO [actor, instance]
                 |     allocates threads and tracks their relationships
                 +-- ThreadDO [actor, instance, thread]
                       stores events and workspace data
                       executes the actor and schedules recovery alarms
```

Each thread has its own Durable Object and SQLite storage. Child threads use separate objects. The host supports `independent` placement; requests for `colocated` placement are rejected. Alarms resume interrupted work and enforce unresolved method deadlines.

Model inference reads the catalog snapshot bundled in `models.lock.json`. Provider connections and credentials come from the Worker environment. The host checks that the lock matches the model configuration. Run `tdg models lock` to refresh it. Public catalog discovery uses the `CATALOG_DB` D1 binding.

## Bindings and deployment

Point `wrangler.jsonc` at your Worker entry point and declare these bindings:

| Binding | Purpose |
| --- | --- |
| `ACTORS` | Durable Object namespace for `ActorDO` |
| `THREADS` | Durable Object namespace for `ThreadDO` |
| `CATALOG_DB` | D1 database for public model catalog discovery |
| `LOADER` | Worker Loader used by Code Mode |

Declare `ActorDO` and `ThreadDO` as SQLite classes in the Durable Object migrations. The generated project includes the bindings and [catalog migration](migrations/0001_catalog.sql). Follow the [Cloudflare setup guide](../../docs/platforms/cloudflare.mdx#configure) to create the catalog database, apply its migration, and set provider secrets. The same guide covers [local verification](../../docs/platforms/cloudflare.mdx#verify-locally).

`/healthz`, `/v1/providers`, `/v1/models`, `/openapi.json`, and `/docs` are public. Other API routes require `Authorization: Bearer <TARDIGRADE_TOKEN>`. Missing server authentication returns `503`; an incorrect token returns `401`.

`workerHttp(host)` serves a Scalar API reference at `/docs` and its OpenAPI document at `/openapi.json`. The document describes the routes mounted by the Worker. `GET /v1/methods` supplies the actor methods' input and output schemas.

See the [actor guide](../../docs/getting-started/actors.mdx) for thread allocation and method calls.

## Host options

Pass application hooks and policies to `defineWorkerHost(definition, options)`:

| Option | Purpose |
| --- | --- |
| `layersFor` | Supply application Effect services using the Worker environment, actor instance, and thread |
| `storeFor` | Select event encoding and event-key indexing for each thread |
| `inferenceObserverFor` | Receive transient model output through an application binding |
| `defaultChildPlacement` | Set the supported child placement, `independent` |
| `backgroundTaskOwner` | Keep work with the host or attach it to the request through `waitUntil` |

The [option types](src/worker.ts) and [application hooks](src/assembly.ts) define the available overrides. The [Worker environment](src/env.ts) lists configuration bindings for authentication, model discovery, recovery alarms, and sandbox limits. Event encoding and key management are described by the [storage policies](src/storage.ts); [integration tests](test/actor.workers.ts) exercise application services, storage, routing, and recovery.

## Celld

Celld runs the same Worker and Durable Object exports on a self-hosted fleet. Its generated manifest selects `replay` sandbox transport and `request` background-task ownership. Cloudflare defaults to direct capability transport and `host` ownership.

Follow the [Celld guide](../../docs/platforms/celld.mdx) for deployment and node configuration. The [Worker Loader platform](../worker-loader/README.md) covers sandbox policies and tests on both runtimes.

## Verify this platform

From the repository root:

```sh
bun run --cwd platform/cloudflare typecheck
bun run --cwd platform/cloudflare test
bun run --cwd platform/cloudflare test:workers
bun run --cwd platform/cloudflare bundle
```
