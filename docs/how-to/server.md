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
| `GET /v1/providers` | Search and page provider setup requirements. `search`, `cursor`, `limit` |
| `GET /v1/models` | Search and page public model metadata. `provider`, `search`, `cursor`, `limit` |
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
| `TARDIGRADE_TOKEN` | Unset. When set, actor routes need `Authorization: Bearer`. `/healthz`, `/v1/providers`, `/v1/models`, `/openapi.json`, and `/docs` stay public |
| `TARDIGRADE_CONFIG_PATH` | `tardigrade.jsonc`. Ordinary project configuration for a directly hosted server |
| `TARDIGRADE_MODEL_CATALOG_URL` | `https://models.dev/api.json`. Source for the public model catalog |
| `TARDIGRADE_MODEL_CATALOG_CACHE` | `.tardigrade/models.json`. Last validated public snapshot |
| `TARDIGRADE_MODEL_CATALOG_TIMEOUT_MILLIS` | `10000`. Startup refresh timeout |
| Provider credentials | Set each variable named by a provider's `env` list. Use deployment secrets on a hosted server |

The server boots without a provider connection and serves every read; turns fail naming what is missing. An actor selects a configured provider and any model that provider exposes in the catalog. The built-in actor uses the configured default. Interactive `tdg setup` writes ordinary configuration to `tardigrade.jsonc` and credentials to the project `.env`. The declarative `tdg setup provider <provider> <config>` command writes the connection and leaves secret values in the deployment environment. The `provider` and `default` subcommands change those concerns independently.

```jsonc
{
  "models": {
    "default": { "provider": "openrouter", "model_id": "anthropic/claude-sonnet-4-6" },
    "providers": {
      "openrouter": {
        "baseUrl": "https://openrouter.ai/api/v1",
        "protocol": "openai-chat-completions",
        "env": ["OPENROUTER_API_KEY"]
      }
    }
  }
}
```

```dotenv
OPENROUTER_API_KEY='your-deployment-secret'
```

The server refreshes the public model catalog when it starts, validates the complete provider and model listing, and replaces the cache atomically. A failed refresh serves the last valid snapshot for the configured source with `status: "cached"`. The server keeps the resolved snapshot in memory, so model resolution and catalog requests do not read the cache file on each request. With no valid source or cache, both catalog endpoints answer 503. Provider credentials never appear in either response.

Catalog responses use cursor pagination. They include `revision`, `status`, `refreshed_at`, `total`, `limit`, `items`, and optional `next_cursor`. The default limit is `50` and callers can state another positive integer. Search is a case-insensitive substring over IDs and names. `GET /v1/models` also accepts an exact provider filter. Pass `next_cursor` with the same filters to continue. A cursor records the catalog revision and query, so a changed revision or filter returns 400 and the caller starts again without a cursor.

## Clients

`tardie/client` is generated from the same declaration this server implements, so `/openapi.json` and the client cannot drift from it.

```ts
import { agentMethods } from "tardie"
import { makeClient } from "tardie/client"

const client = makeClient({ baseUrl: "http://localhost:4242", methods: agentMethods })
await client.invoke("inv-81", "message", { id: "m1", input: { text: "audit the deploy" } })
```
