# Run the server

The server is the self-hostable deployable: one Bun process that holds a durable SQLite log, runs the default agent assembly over it, and exposes HTTP. The assembly is code mode with the spawn and workspace packages in scope, plus reply, budget, and compaction. Everything the API answers is derived from the log, so the process keeps no state a restart could lose.

## What the API names

The API has four levels, and a route names the first three.

| Level | What it is |
| --- | --- |
| Actor | The deployed code, addressed by name. This build compiles one assembly in and serves it as `agent` (`RESERVED_ACTOR`); every other name is a `404 unknown-actor`. |
| Thread | One log, resumable forever. It is the resource every read projects from, and it exists once its log has an event. |
| Turn | One inbound message and the work it caused, named by the message id. |
| Event | One fact, recorded once, numbered by its position in the log. |

The platform's guarantee stops at the thread: a durable log, one writer, and a settle loop. Whether the reactors over that log constitute an agent is the assembly's business, which is why the actor is the level a deploy will vary and the thread is the level a route reads.

Every versioned route lives under `/v1`. `/healthz`, `/openapi.json`, and `/docs` describe the process rather than its resources, so they stay unversioned.

## Run it

```bash
bun run --cwd apps/server start
```

The process opens the store, recovers whatever an earlier death interrupted, and listens. It drives continuously: a delivered message starts a turn and the loop settles it, so a client observes rather than asks for work.

Configuration is the environment and nothing else. Every default is an exported constant in `apps/server/src/config.ts`.

| Variable | Default | What it sets |
| --- | --- | --- |
| `PORT` | `4111` (`DEFAULT_PORT`) | The port the process listens on. A value that is not an integer between 0 and 65535 refuses to start. |
| `TARDIGRADE_DB` | `agents.sqlite` (`DEFAULT_DB`) | The SQLite file that holds every log. A relative path resolves against the working directory. |
| `TARDIGRADE_TOKEN` | absent | A bearer token required on every route except `/healthz`. Absent leaves the API open, which is why the process is meant to bind to localhost. |
| `MODEL_BASE_URL` | absent | The OpenAI-compatible endpoint the model binding calls. |
| `MODEL_API_KEY` | absent | The credential for that endpoint. |
| `MODEL_ID` | absent | The model the binding asks for. |
| `MODEL_PROVIDER` | absent | The protocol, when the endpoint is not OpenAI-compatible. `bedrock` selects Bedrock. |

## Running without a model

The process boots without model coordinates. It listens, answers `/healthz`, accepts messages, and every turn it drives fails with `no model is configured: set MODEL_BASE_URL, MODEL_API_KEY, and MODEL_ID`. The failure is an event in the log like any other, so `GET /v1/actors/agent/threads/:id/turns/:turn` reports the turn as `failed` and carries that sentence as its error. Set the three variables and `POST /v1/actors/agent/threads/:id/turns/:turn/resume` runs the same turn again from where it stopped. A server that refused to start without a model would hide the log an operator can already read.

## Endpoints

| Endpoint | Contract |
| --- | --- |
| `POST /v1/actors/agent/threads/:id/events` | Deliver one message, `{ id, text, input?, data? }`. Answers `202 { actor, thread, turn }`, or `400` when the body states no `id` or no `text`. |
| `GET /v1/actors/agent/threads` | Every thread, parent before child, as a summary: id, parent, event count, last event time, and status (`settled`, `running`, `blocked`, `failed`). |
| `GET /v1/actors/agent/threads/:id/events` | The log as `{ seq, event }` rows. `after` starts the page past a sequence number, `limit` caps it (default 200, `DEFAULT_EVENT_LIMIT`), `types` filters by a comma list. |
| `GET /v1/actors/agent/threads/:id/events/stream` | The same log as `text/event-stream`, replayed from the cursor and then followed live. The tail re-reads every 50 milliseconds (`DEFAULT_SSE_POLL`) and writes a comment frame after 15 seconds of silence (`DEFAULT_SSE_HEARTBEAT`). |
| `GET /v1/actors/agent/threads/:id/turns` | Every turn boundary as `{ turn, status, output?, error? }`, where status is `pending`, `completed`, `failed`, or `parked`. `at` evaluates the projection over a prefix of the log. |
| `GET /v1/actors/agent/threads/:id/turns/:turn` | One turn's boundary, the same shape. This is the poll target for whether a run finished. |
| `POST /v1/actors/agent/threads/:id/turns/:turn/resume` | Resume a failed turn. `202` with the turn handle, `409` when the turn did not fail or belongs to a spent epoch, carrying the library's own reason. |
| `GET /healthz` | `200` while the host answers, carrying `status` (`resting` or `driving`) and `dirty`, the count of drive passes owed. Open even when a token is set, so a supervisor can tell an outage from a misconfiguration. |
| `GET /openapi.json` | The OpenAPI document, derived from the same declaration the routes are built from (`OPENAPI_PATH`). Open even when a token is set. |
| `GET /docs` | That document rendered as a reference page (`DOCS_PATH`). Open even when a token is set. |

Every failure is `application/problem+json`: `{ type, title, status, detail }`, where `type` is a URI under `https://tardigrade.dev/problems/` that a client matches on. A `404` is one of two facts and the `type` says which: `unknown-actor` names code this build does not serve, and `unknown-thread` names a log that has never been written. The actor is answered first, so a real thread under an actor nobody deployed reports `unknown-actor`. An existing thread whose filter matches nothing answers `200 []`. A request that does not match what the endpoint accepts is `400 invalid-request`, whose `detail` names the part that was refused and the fields at fault, as in ``The request body is not what this endpoint accepts. `text` is missing.``

## The routes are one declaration

Every JSON route is an `HttpApiEndpoint` with a Schema for its path parameters, its query, its success body, and each failure it can answer with. The endpoints are grouped and the groups make one `HttpApi`. That declaration is a package of its own, because it has three readers and only one of them is the server: the server implements it through `HttpApiBuilder`, the OpenAPI document is generated from it, and the client is derived from it. The Schemas are the one definition of the wire types: the projections keep hand-written types for the read side, and a compile-time assertion holds the two together, so neither can drift alone.

Because the declaration decides what a request may hold, it is also what refuses one. A sequence number is declared as a whole number at or above zero and a message is declared as a non-empty `id` with a `text`, so nothing hand-parses either. API-wide middleware turns any such refusal into the same problem document, which is why a refused request reads like every other failure and why a route added later inherits the behavior without stating it.

The event stream is the one route outside the declaration. `HttpApi` is request-and-response shaped, and the tail hands back a connection that outlives its handler and carries its own cursor, so it stays a plain router route beside the declared app and inherits the same bearer gate by being part of the same router.

## One client, derived

A caller does not hand-write requests against this API. `makeClient({ baseUrl, token })` reads the same declaration and answers with one method per endpoint, so a call that compiles is a call the server declared. The token rides an `authorization` header on every request. A failed call rejects with the problem document's own four fields, including on a status the declaration never named, because every route answers `problem+json` and the body is read before the status line is fallen back on.

The tail is the one call the client hand-writes, because the stream is the one route outside the declaration. It takes the connection as an argument, defaulting to the runtime's `EventSource`, so a consumer outside a browser supplies its own. It cannot carry the token, since `EventSource` sends no headers; against a server started with a token the tail is refused and a caller falls back to polling the events endpoint, which is an ordinary request.

The client carries Schema into whatever loads it, a browser included. That is the accepted price of one definition of the wire, and the escape hatch, if it ever stops being worth paying, is a zero-dependency client generated from the OpenAPI document the declaration already produces.

## Creation is delivery

There is no create endpoint, no registration, and no lifecycle. A thread exists once its log has an event, so `POST /v1/actors/agent/threads/:id/events` with an id nobody has used births that thread and starts its first turn. The same rule reads backwards: the only unknown thread is one with an empty log, which is what a `404 unknown-thread` on any read reports.

Children born by spawn get derived ids (`<execId>.<n>`) and appear in `GET /v1/actors/agent/threads` and `GET /v1/actors/agent/threads/:id/tree` like any other thread. Parentage is a claim in the parent's log, which is why the tree is derived across every log rather than from the subtree alone.

## Redelivery is absorbed

The message `id` is the dedup key end to end and becomes the turn id. Posting the same id twice answers `202` both times and starts one turn: the host absorbs the second delivery, and the client never learns it retried. An at-least-once caller, a webhook relay, or a shell script in a retry loop needs no care beyond keeping the id stable.

## Streams resume where they dropped

Each log event is one SSE event, and its `id:` field is the sequence number. A dropped connection resumes by sending `Last-Event-ID`, which the server prefers over the `after` query, because a reconnecting `EventSource` replays the URL it was opened with and that URL points at where the first connection began. The cursor is the count of events sent, so a resumed stream sends no event twice and skips none.

## Time travel is a query

Any prefix of a log is a valid state, so reading the past is a parameter rather than a mode. `GET /v1/actors/agent/threads/:id/turns?at=<seq>` evaluates the turn projection over the first `<seq>` events, which is what the thread's outcome looked like at that point. Nothing is stored to make this work: the projection is a pure function of the events it is handed.

## Out of scope

The server runs one assembly, chosen in code, and forking is the customization path. Four things it does not do:

- **Inbound sources.** Provider webhooks becoming messages arrive with the `Package.source` spec that defines them.
- **Connections and credential storage.** The door's values arrive with that same spec.
- **Per-thread assembly configuration.** Capabilities and packages as a wire format reopen every composition question, so the assembly stays a code decision in `apps/server/src/host.ts`.
- **Budget answers over HTTP.** A parked turn reports `parked`; answering the ask needs the synchronous call doors the in-process host refuses, and waits on a consumer shape that needs them.

Multi-tenancy, quotas, and users are outside the frame entirely: one store, one operator.
