# HTTP server

An HTTP server over a durable SQLite log. It holds threads, runs the actor, and serves what the actor declares.

## Run it

```bash
tdg dev                    # or: bun run --cwd apps/server start
```

Bun 1.4 or later. `GET /healthz` answers once it is up.

## Endpoints

Base path `/v1`. The built-in actor is named `default`.

| | |
| --- | --- |
| `GET /v1/providers` | Search and page provider connection requirements. `search`, `cursor`, `limit` |
| `GET /v1/models` | Search and page model metadata. `provider`, `search`, `cursor`, `limit` |
| `GET /v1/actors` | List actors |
| `PUT /v1/actors` | Push an actor artifact |
| `GET /v1/actors/{actor}/methods` | List methods with standalone input and output schemas |
| `GET /v1/actors/{actor}/threads` | List threads |
| `PUT /v1/actors/{actor}/threads/{id}/methods/{method}/calls/{call}` | Call a method with its input as the body |
| `GET /v1/actors/{actor}/threads/{id}/methods/{method}/calls/{call}` | Read a method call's derived state |
| `POST /v1/actors/{actor}/threads/{id}/events` | Append an event, creating the thread if new |
| `GET /v1/actors/{actor}/threads/{id}/events` | Read the log. `after`, `limit`, `types` |
| `GET /v1/actors/{actor}/threads/{id}/events/stream` | Follow the log. Server-sent events, resumes from `Last-Event-ID` |
| `GET /v1/actors/{actor}/threads/{id}/projections/{projection}` | Read a projection the actor declares. `default` declares `turns` |
| `GET /v1/actors/{actor}/threads/{id}/tree` | The spawn family |
| `GET /healthz` `GET /openapi.json` `GET /docs` | Unversioned |

```bash
curl -X PUT localhost:4242/v1/actors/default/threads/inv-81/methods/message/calls/m1 \
  -H 'content-type: application/json' \
  -d '{"text":"audit the deploy"}'
# {"actor":"default","thread":"inv-81","method":"message","call":"m1"}

curl localhost:4242/v1/actors/default/threads/inv-81/methods/message/calls/m1
# {"status":"completed","output":"…"}
```

Calling a method is the application ingress. The caller chooses the thread and call ids, and the method schema validates the body. Repeating the same call URL is absorbed by the log.

Appending is the lower-level ingress for channels and interventions. The host atomically records `ThreadCreated` before the first delivered event. A spawned child records its parent address and depth in that creation event, so the tree survives changes to thread naming.

Reads are projections of the log, so `?at=<seq>` answers as of that point in history.

The server fetches the models.dev catalog once during startup and keeps the validated snapshot in memory. A successful refresh has `status: "fresh"`. A failed refresh may serve the last file or D1 snapshot with `status: "cached"`. Each page includes the source `revision`, refresh time, total count, page limit, and an opaque `next_cursor` when another page exists. The default page limit is 50 and callers may set `limit`.

## Errors

Every failure is `application/problem+json`.

```json
{ "type": "https://tardigrade.dev/problems/unknown-thread",
  "title": "Unknown Thread", "status": 404,
  "detail": "No thread named \"ghost\" has ever existed." }
```

`unknown-actor` names code this server does not run. `unknown-projection` lists what the actor does declare. `invalid-request` names the field it refused.

## Configuration

| | |
| --- | --- |
| `PORT` | `4242` |
| `TARDIGRADE_DB` | `.tardigrade/agents.sqlite` |
| `TARDIGRADE_MAX_CONCURRENT_LANES` | Maximum actor lanes settled at once. Defaults to `4` |
| `TARDIGRADE_TOKEN` | Unset. When set, actor routes need `Authorization: Bearer`. Health, catalog, OpenAPI, and docs routes stay public |
| `TARDIGRADE_MODEL_CATALOG_URL` | `https://models.dev/api.json` |
| `TARDIGRADE_MODEL_CATALOG_CACHE` | `.tardigrade/models.json` |
| `TARDIGRADE_MODEL_CATALOG_TIMEOUT_MILLIS` | `10000` |
| `MODEL_BASE_URL` `MODEL_API_KEY` `MODEL_ID` `MODEL_PROVIDER` | The model you supply. `tdg setup` writes these to a file instead |
| `MODEL_OUTPUT_GUARANTEE` `MODEL_OUTPUT_WITH_TOOLS` | What this endpoint and this model promise about a declared output contract: `native` with `true` or `false` for whether the schema rides beside a tool list, or `none`. A provider name proves nothing here, so an undeclared endpoint serves a contract only through a mounted fallback |

The server boots without a model and serves every read; turns fail naming what is missing.

## Clients

`tardie/client` is generated from the same declaration this server implements, so `/openapi.json` and the client cannot drift from it.

```ts
import { agentMethods } from "tardie"
import { makeClient } from "tardie/client"

const client = makeClient({ baseUrl: "http://localhost:4242", methods: agentMethods })
await client.invoke("inv-81", "message", { id: "m1", input: { text: "audit the deploy" } })
```
