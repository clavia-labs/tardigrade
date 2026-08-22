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
| `GET /v1/actors/{actor}/threads` | List threads |
| `POST /v1/actors/{actor}/threads/{id}/events` | Append an event, creating the thread if new |
| `GET /v1/actors/{actor}/threads/{id}/events` | Read the log. `after`, `limit`, `types` |
| `GET /v1/actors/{actor}/threads/{id}/events/stream` | Follow the log. Server-sent events, resumes from `Last-Event-ID` |
| `GET /v1/actors/{actor}/threads/{id}/{projection}` | A projection the actor declares. `agent` declares `turns` |
| `GET /v1/actors/{actor}/threads/{id}/tree` | The spawn family |
| `GET /healthz` `GET /openapi.json` `GET /docs` | Unversioned |

```bash
curl -X POST localhost:4242/v1/actors/default/threads/inv-81/events \
  -d '{"id":"m1","type":"MessageReceived","text":"audit the deploy"}'
# {"actor":"agent","thread":"inv-81"}

curl localhost:4242/v1/actors/default/threads/inv-81/turns
# [{"turn":"m1","status":"completed","output":"…","epoch":0}]
```

Appending is how a thread is created, messaged, and intervened in. The id is the dedup key, so sending the same event twice changes nothing.

Reads are projections of the log, so `?at=<seq>` answers as of that point in history.

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
| `TARDIGRADE_TOKEN` | Unset. When set, every route but `/healthz`, `/openapi.json`, and `/docs` needs `Authorization: Bearer` |
| `MODEL_BASE_URL` `MODEL_API_KEY` `MODEL_ID` `MODEL_PROVIDER` | The model you supply. `tdg setup` writes these to a file instead |
| `MODEL_OUTPUT_GUARANTEE` `MODEL_OUTPUT_WITH_TOOLS` | What this endpoint and this model promise about a declared output contract: `native` with `true` or `false` for whether the schema rides beside a tool list, or `none`. A provider name proves nothing here, so an undeclared endpoint serves a contract only through a mounted fallback ([structured output](../output.md)) |

The server boots without a model and serves every read; turns fail naming what is missing.

## Clients

`tardie/client` is generated from the same declaration this server implements, so `/openapi.json` and the client cannot drift from it.

```ts
import { makeClient } from "tardie/client"

const client = makeClient({ baseUrl: "http://localhost:4242" })
await client.append("inv-81", { id: "m1", type: "MessageReceived", text: "audit the deploy" })
```
