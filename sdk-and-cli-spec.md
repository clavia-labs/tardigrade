# SDK and CLI (draft 1)

Two pieces, one dependency between them: the server's routes become a declared `HttpApi`, and everything else derives from that declaration. The CLI is then a thin front door, and the voyager stops hand-maintaining a copy of the wire types.

## Phase 1: the API becomes a declaration

`apps/server` currently builds routes as layer-shaped `HttpRouter` handlers, and the contract lives in prose. Rewrite it as an `HttpApi` (all in-package with effect, no new dependency):

- `HttpApiEndpoint` per route, with Schema for path params, query, success, and errors. The eight endpoints from the server spec, minus the stream (below).
- `HttpApiGroup` for the agents group, `HttpApi` for the whole surface.
- `HttpApiBuilder` implements it, calling the same `Agents` service and the same pure projections. The projections do not change; only the plumbing above them does.
- Errors keep the problem+json shape through `HttpApiSchema` annotations, so the wire contract stays what the voyager already renders.

What falls out of that declaration for free: `HttpApiClient` (a typed client), `OpenApi.fromApi` (a spec derived from the implementation, so it cannot drift), and a `/docs` page via `HttpApiScalar`.

The SSE stream stays on `HttpRouter`. `HttpApi` is request-and-response shaped, and forcing a stream through it buys nothing. The client hand-writes the small `stream()` helper over `EventSource`, exactly as it does today.

## Phase 2: one client

`HttpApiClient.make(Api, { baseUrl })` is the client, published as `@clavia/tardigrade/client` through a MEMBERS entry in `tools/publish.ts`. It replaces `apps/voyager/src/api.ts` entirely: the hand-copied `AgentSummary`, `TurnView`, and `EventRow` types die, and the server's Schemas become the one definition all three consumers read.

Effect and Schema enter the browser bundle. That is accepted, with one obligation: measure the built bundle in the same PR and record the number, so a later regression has a baseline to fail against. If the number ever stops being acceptable, the escape hatch is generating a zero-dependency client from our own OpenAPI document, which the declaration already produces.

The bearer token and the base URL stay client construction options. `problem+json` failures surface as typed errors the UI renders verbatim.

## Phase 3: the CLI

`apps/cli`, published as the `tdg` bin on the same npm package, so one install gives the library, the server, the UI, and the command.

    tdg dev                      boot the API and serve the voyager's build at one URL
    tdg run "<brief>"            deliver, drive to quiescence, print the terminal
    tdg send <agent> "<brief>"   deliver and print the turn handle
    tdg ls                       the runs a store holds
    tdg events <agent>           the log, for piping

`run` is reserved for running an agent, which is why the dev command is `tdg dev` rather than `tdg run dev`.

Every command is a few lines over the client. `tdg dev` boots one process: the server owns the log, the driver, and the HTTP surface, and serves the voyager's built assets at `/`. One URL, one port, one thing to kill. Inside the repo, Vite still runs separately for hot reload.

Configuration resolves in one place and is the server's existing environment surface (`PORT`, `TARDIGRADE_DB`, `TARDIGRADE_TOKEN`, the `MODEL_*` fields), with flags overriding env. With no model configured the server still boots and turns fail with the message the server already gives, so the first run is honest rather than broken.

The CLI is also the write surface. The voyager is read-only by decision, so `tdg send` and `tdg run` are how an agent gets created outside a script.

## Sequencing

The voyager PR lands first, since phase 2 deletes the file that PR is still editing. Then phase 1 and 2 as one PR (the declaration and the client that derives from it, with the voyager migrated in the same change, because the old client dies with it). Then phase 3.

## Out of scope

Generated clients for other languages (the OpenAPI document makes that a downstream job), auth beyond the existing bearer token, and any command that mutates a running agent beyond delivering a message.
