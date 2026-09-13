import { Effect, Layer } from "effect"
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"

import {
  layerActorsGroup,
  layerDefinitionsGroup,
  layerMethodsGroup,
  layerModelsGroup,
  layerProjectionsGroup,
  layerRuntimeGroup,
  layerStream,
  layerThreadsGroup,
  layerUnknownProjection,
  type ApiOptions
} from "./api"
import { Api, apiOf, type Health } from "@clavia/tardigrade-client/contract"
import { layerRequestProblems } from "./contract"
import { DriverGauge } from "./driver-gauge"
import { layerApiDocs, UNAUTHENTICATED_PATHS } from "./docs"
export { UNAUTHENTICATED_PATHS } from "./docs"

// The HTTP surface. The JSON routes are one declaration (contract.ts) implemented through
// HttpApiBuilder, and everything around them is a layer over effect's own HttpRouter, so the server
// is assembled the way the rest of the repository is assembled and the Bun binding is the only
// platform-specific piece (main.ts, http.test.ts). This module owns the conventions every route
// inherits: the error body, the bearer gate, and the health probe that reads the driver rather than
// the process.

import { problem } from "./problem"
export { problem, type Problem, PROBLEM_CONTENT_TYPE, PROBLEM_TYPE_BASE } from "./problem"

const pathOf = (url: string): string => {
  const query = url.indexOf("?")
  const path = query === -1 ? url : url.slice(0, query)
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path
}

const bearerOf = (headers: Headers.Headers): string | undefined => {
  const header = headers["authorization"]
  if (header === undefined) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim()
}

// Constant-time over the shared length, so a comparison does not leak the token a character at a
// time. Lengths differing is already public through the response, so only the overlap is timed.
const secretEquals = (a: string, b: string): boolean => {
  let diff = a.length ^ b.length
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// The whole auth story for v1: TARDIGRADE_TOKEN absent leaves every route open, present makes a
// matching bearer token required on everything but UNAUTHENTICATED_PATHS (apps-server-spec.md,
// "Conventions"; http.test.ts, "a token closes the API and leaves healthz open").
export const layerAuth = (token?: string) => HttpRouter.middleware(
  Effect.succeed((httpEffect) => {
    if (token === undefined) return httpEffect
    return Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
      if (UNAUTHENTICATED_PATHS.includes(pathOf(request.url))) return httpEffect
      const presented = bearerOf(request.headers)
      if (presented === undefined) {
        return Effect.succeed(
          HttpServerResponse.setHeader(
            problem({
              status: 401,
              kind: "unauthorized",
              title: "Unauthorized",
              detail: "This server requires a bearer token."
            }),
            "www-authenticate",
            "Bearer"
          )
        )
      }
      if (!secretEquals(presented, token)) {
        return Effect.succeed(
          problem({
            status: 403,
            kind: "forbidden",
            title: "Forbidden",
            detail: "The bearer token is not the one this server was started with."
          })
        )
      }
      return httpEffect
    })
  }),
  { global: true }
)

// The probe's body is the wire type the declaration states (contract.ts, Health).
export type { Health }

// 200 whenever the host answers, carrying the driver's state and the count of threads that still owe
// work (docs/how-to/server.md, "Endpoints").
export const layerHealthGroup = HttpApiBuilder.group(Api, "health", (handlers) =>
  handlers.handle("healthz", () =>
    Effect.gen(function*() {
      const gauge = yield* DriverGauge
      return {
        status: (yield* gauge.resting) ? "resting" as const : "driving" as const,
        dirty: yield* gauge.dirty
      }
    })))

// A route the router did not match is a problem document like any other failure, so a client never
// has to parse two error shapes.
export const layerNotFound = HttpRouter.add(
  "*",
  "*",
  Effect.succeed(
    problem({
      status: 404,
      kind: "not-found",
      title: "Not Found",
      detail: "No route matches this path."
    })
  )
)

// The headers a browser may send. `traceparent` and `b3` are on the list because the derived client
// propagates its span into every request (packages/client, HttpClient tracing), and a preflight
// that refuses them refuses the call: a header this server's own client sends is a header this
// server accepts (http.test.ts, "the preflight allows what the client sends").
export const ALLOWED_HEADERS: ReadonlyArray<string> = [
  "authorization",
  "content-type",
  "last-event-id",
  "idempotency-key",
  "traceparent",
  "b3"
]

// Permissive on every origin, because the process is meant to bind to localhost and the voyager is
// served from a Vite dev server on another port during development (apps-server-spec.md,
// "Conventions"). An operator who exposes the port relies on TARDIGRADE_TOKEN, not on the browser.
export const layerCors = HttpRouter.cors({
  allowedHeaders: [...ALLOWED_HEADERS],
  exposedHeaders: ["content-type", "location"]
})

// The application: the declared API, the stream beside it, the document and the page derived from
// the same declaration, plus the conventions that wrap them all. A route inherits the gate and the
// error shape by being part of the same router.
export const layerApp = (options: ApiOptions = {}) => {
  const api = apiOf(options.projections ?? {})
  return Layer.mergeAll(
    Layer.provide(
      Layer.provide(HttpApiBuilder.layer(api), [
        layerActorsGroup,
        layerDefinitionsGroup,
        layerModelsGroup(options),
        layerRuntimeGroup,
        layerThreadsGroup(options),
        layerMethodsGroup,
        layerProjectionsGroup(options.projections),
        layerHealthGroup
      ]),
      layerRequestProblems
    ),
    layerApiDocs(api),
    layerStream(options),
    // layerUnknownProjection names the declared projections when a lookup misses.
    layerUnknownProjection(options.projections),
    layerNotFound,
    layerCors,
    layerAuth(options.token)
  )

}

// serve starts the application on whichever HttpServer is provided, which is the only seam a
// platform binding needs: Bun in main.ts, an ephemeral test server in http.test.ts. The request log
// is on by default because an operator watching one process wants it, and off where a test would
// otherwise print a line per request.
export const serve = (options?: {
  readonly disableLogger?: boolean | undefined
  readonly disableListenLog?: boolean
  readonly api?: ApiOptions
}) => HttpRouter.serve(layerApp(options?.api), options)
