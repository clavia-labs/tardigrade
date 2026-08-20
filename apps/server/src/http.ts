import { Context, Effect, Layer } from "effect"
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

import { layerApi } from "./api"
import { ServerConfig } from "./config"

// The HTTP surface. Routes are layers over effect's own HttpRouter, so the server is assembled the
// way the rest of the repository is assembled, and the Bun binding is the only platform-specific
// piece (main.ts, http.test.ts). This module owns the conventions every later route inherits: the
// error body, the bearer gate, and the health probe that reads the driver rather than the process.

// The health probe's view of the host driver. The server never asks the driver to run; it asks what
// the driver is doing, which is the whole of "the server drives continuously" from the client's
// side (apps-server-spec.md, "Principles"). Two questions, because /healthz answers two: is the
// driver resting, and how many lanes still owe work.
export class DriverGauge extends Context.Service<
  DriverGauge,
  {
    readonly resting: Effect.Effect<boolean>
    readonly dirty: Effect.Effect<number>
  }
>()("tardigrade/server/DriverGauge") {}

// A gauge for a process with no host attached. It reports a resting driver with nothing owed, which
// is true of a server that has not been given one (http.test.ts, "healthz reports the gauge").
export const layerGaugeResting: Layer.Layer<DriverGauge> = Layer.succeed(DriverGauge)({
  resting: Effect.succeed(true),
  dirty: Effect.succeed(0)
})

import { problem } from "./problem"
export { problem, type Problem, PROBLEM_CONTENT_TYPE, PROBLEM_TYPE_BASE } from "./problem"

// Paths the bearer gate lets through. /healthz is a liveness probe: a supervisor that has to hold a
// credential to learn the process is up cannot tell an outage from a misconfiguration.
export const UNAUTHENTICATED_PATHS: ReadonlyArray<string> = ["/healthz"]

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
export const layerAuth = HttpRouter.middleware(
  Effect.map(ServerConfig, (config) => (httpEffect) => {
    const token = config.token
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

export interface Health {
  readonly status: "resting" | "driving"
  readonly dirty: number
}

// 200 whenever the host answers, carrying the driver's state and the count of lanes that still owe
// work (apps-server-spec.md, "GET /healthz").
export const layerHealthz = HttpRouter.add(
  "GET",
  "/healthz",
  Effect.gen(function*() {
    const gauge = yield* DriverGauge
    const body: Health = {
      status: (yield* gauge.resting) ? "resting" : "driving",
      dirty: yield* gauge.dirty
    }
    return HttpServerResponse.jsonUnsafe(body)
  })
)

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

// Permissive on every origin, because the process is meant to bind to localhost and the voyager is
// served from a Vite dev server on another port during development (apps-server-spec.md,
// "Conventions"). An operator who exposes the port relies on TARDIGRADE_TOKEN, not on the browser.
export const layerCors = HttpRouter.cors({
  allowedHeaders: ["authorization", "content-type", "last-event-id"],
  exposedHeaders: ["content-type"]
})

// The application: every route, plus the conventions that wrap them. Routes added by later modules
// merge in here, and inherit the gate and the error shape by being part of the same router.
//
// The agent routes are suspended because api.ts reads this module's conventions and this module
// reads its routes: whichever of the two a consumer imports first, the merge names `layerApi` after
// both module bodies have run (api.test.ts imports api.ts first).
export const layerApp = Layer.mergeAll(
  layerApi(),
  layerHealthz,
  layerNotFound,
  layerCors,
  layerAuth
)

// serve starts the application on whichever HttpServer is provided, which is the only seam a
// platform binding needs: Bun in main.ts, an ephemeral test server in http.test.ts. The request log
// is on by default because an operator watching one process wants it, and off where a test would
// otherwise print a line per request.
export const serve = (options?: {
  readonly disableLogger?: boolean | undefined
  readonly disableListenLog?: boolean
}) => HttpRouter.serve(layerApp, options)
