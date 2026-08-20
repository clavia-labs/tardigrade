# Run the server

The server is the self-hostable deployable: one Bun process that holds a durable SQLite log, runs the default agent assembly over it, and exposes HTTP. The assembly is code mode with the spawn and workspace packages in scope, plus reply, budget, and compaction. Everything the API answers is derived from the log, so the process keeps no state a restart could lose.

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

The process boots without model coordinates. It listens, answers `/healthz`, accepts messages, and every turn it drives fails with `no model is configured: set MODEL_BASE_URL, MODEL_API_KEY, and MODEL_ID`. The failure is an event in the log like any other, so `GET /agents/:id/turns/:turn` reports the turn as `failed` and carries that sentence as its error. Set the three variables and `POST /agents/:id/turns/:turn/resume` runs the same turn again from where it stopped. A server that refused to start without a model would hide the log an operator can already read.

## Endpoints

| Endpoint | Contract |
| --- | --- |
| `POST /agents/:id/messages` | Deliver one message, `{ id, text, input?, data? }`. Answers `202 { agent, turn }`, or `400` when the body states no `id` or no `text`. |
| `GET /agents` | Every agent, parent before child, as a summary: id, parent, event count, last event time, and status (`settled`, `running`, `blocked`, `failed`). |
| `GET /agents/:id/events` | The log as `{ seq, event }` rows. `after` starts the page past a sequence number, `limit` caps it (default 200, `DEFAULT_EVENT_LIMIT`), `types` filters by a comma list. |
| `GET /agents/:id/events/stream` | The same log as `text/event-stream`, replayed from the cursor and then followed live. The tail re-reads every 50 milliseconds (`DEFAULT_SSE_POLL`) and writes a comment frame after 15 seconds of silence (`DEFAULT_SSE_HEARTBEAT`). |
| `GET /agents/:id/turns` | Every turn boundary as `{ turn, status, output?, error? }`, where status is `pending`, `completed`, `failed`, or `parked`. `at` evaluates the projection over a prefix of the log. |
| `GET /agents/:id/turns/:turn` | One turn's boundary, the same shape. This is the poll target for whether a run finished. |
| `POST /agents/:id/turns/:turn/resume` | Resume a failed turn. `202` with the turn handle, `409` when the turn did not fail or belongs to a spent epoch, carrying the library's own reason. |
| `GET /healthz` | `200` while the host answers, carrying `status` (`resting` or `driving`) and `dirty`, the count of drive passes owed. Open even when a token is set, so a supervisor can tell an outage from a misconfiguration. |

Every failure is `application/problem+json`: `{ type, title, status, detail }`, where `type` is a URI under `https://tardigrade.dev/problems/` that a client matches on. A `404` on a read means the agent has never existed; an existing agent whose filter matches nothing answers `200 []`.

## Creation is delivery

There is no create endpoint, no registration, and no lifecycle. An agent exists once its log has an event, so `POST /agents/:id/messages` with an id nobody has used births that agent and starts its first turn. The same rule reads backwards: the only unknown agent is one with an empty log, which is what a `404` on any read reports.

Children born by spawn get derived ids (`<execId>.<n>`) and appear in `GET /agents` and `GET /agents/:id/tree` like any other agent. Parentage is a claim in the parent's log, which is why the tree is derived across every log rather than from the subtree alone.

## Redelivery is absorbed

The message `id` is the dedup key end to end and becomes the turn id. Posting the same id twice answers `202` both times and starts one turn: the host absorbs the second delivery, and the client never learns it retried. An at-least-once caller, a webhook relay, or a shell script in a retry loop needs no care beyond keeping the id stable.

## Streams resume where they dropped

Each log event is one SSE event, and its `id:` field is the sequence number. A dropped connection resumes by sending `Last-Event-ID`, which the server prefers over the `after` query, because a reconnecting `EventSource` replays the URL it was opened with and that URL points at where the first connection began. The cursor is the count of events sent, so a resumed stream sends no event twice and skips none.

## Time travel is a query

Any prefix of a log is a valid state, so reading the past is a parameter rather than a mode. `GET /agents/:id/turns?at=<seq>` evaluates the turn projection over the first `<seq>` events, which is what the agent's outcome looked like at that point. Nothing is stored to make this work: the projection is a pure function of the events it is handed.

## Out of scope

The server runs one assembly, chosen in code, and forking is the customization path. Four things it does not do:

- **Inbound sources.** Provider webhooks becoming messages arrive with the `Package.source` spec that defines them.
- **Connections and credential storage.** The door's values arrive with that same spec.
- **Per-agent assembly configuration.** Capabilities and packages as a wire format reopen every composition question, so the assembly stays a code decision in `apps/server/src/host.ts`.
- **Budget answers over HTTP.** A parked turn reports `parked`; answering the ask needs the synchronous call doors the in-process host refuses, and waits on a consumer shape that needs them.

Multi-tenancy, quotas, and users are outside the frame entirely: one store, one operator.
