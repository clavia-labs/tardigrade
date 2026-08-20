import { Effect, Layer } from "effect"
import { HttpRouter, HttpStaticServer } from "effect/unstable/http"
import { BunHttpServer } from "@effect/platform-bun"
import { layerConfig, type ServerConfigValue } from "@clavia/tardigrade-server/config"
import { layerAgents, type AgentsOptions } from "@clavia/tardigrade-server/host"
import { layerApp } from "@clavia/tardigrade-server/http"

import { resolveAssets } from "./assets"

// One process: the server's own application, plus the voyager's build at `/`. The API paths are the
// server's, unchanged, because the application layer is the server's own; this module adds one
// fallback beside it (dev.test.ts, "the API answers and the UI is served from one port").

// The interface this command binds. It is stated rather than defaulted, and there is no flag to
// widen it: the process is ungated, so what keeps it private is the interface rather than a secret,
// and a server meant to be reachable by anyone else is the server run directly with a token
// (docs/how-to/server.md, dev.test.ts, "the API answers without a token, on loopback").
export const DEV_HOST = "127.0.0.1"

// The status that means the router matched nothing. It is the seam the UI is served through: the
// declared routes answer first, and only a path none of them owns reaches the build.
export const UNMATCHED = 404

// layerVoyager serves a built directory under whatever the router did not match. It is a middleware
// rather than a `GET /*` route because the server already answers every unmatched path with a
// problem document (apps/server/src/http.ts, layerNotFound), and two catch-alls in one router is an
// ambiguity rather than a fallback.
//
// A path that names a file is served as that file. A path that names nothing is served the index
// when the caller accepts HTML, which is what makes a deep link into the UI work and what keeps an
// API 404 a problem document for a caller that asked for JSON (dev.test.ts, "the API answers and
// the UI is served from one port").
export const layerVoyager = (root: string) =>
  HttpRouter.middleware(
    Effect.map(
      HttpStaticServer.make({ root, spa: true }),
      (assets) => (httpEffect) =>
        Effect.flatMap(httpEffect, (response) =>
          response.status === UNMATCHED
            ? Effect.orElseSucceed(assets, () => response)
            : Effect.succeed(response))
    ),
    { global: true }
  )

export interface DevOptions {
  readonly config: ServerConfigValue
  // Where the built UI lives. Absent, the two layouts a build can arrive in are tried in order
  // (assets.ts, ASSET_CANDIDATES).
  readonly assets?: string | undefined
  // The model seam, which a test binds to a scripted mind (apps/server/src/host.ts, AgentsOptions).
  readonly agents?: AgentsOptions | undefined
  readonly disableLogger?: boolean | undefined
  readonly disableListenLog?: boolean | undefined
}

// dev is the whole command: resolve the build, open the store, listen on loopback. It answers a
// Layer rather than a running process, so the caller owns the scope and the process that stops
// listening stops writing (apps/server/src/host.ts, layerAgents).
export const dev = (options: DevOptions) => {
  const root = resolveAssets(options.assets)
  const config = layerConfig(options.config)
  const agents = Layer.provide(layerAgents(options.agents ?? {}), config)
  // provideMerge rather than provide: the listening server stays visible in the layer's own
  // services, which is what lets a caller read the address it was given when it asked for port 0
  // (dev.test.ts).
  return Layer.provideMerge(
    HttpRouter.serve(Layer.mergeAll(layerApp(), layerVoyager(root)), {
      disableLogger: options.disableLogger ?? false,
      disableListenLog: options.disableListenLog ?? false
    }),
    [BunHttpServer.layer({ port: options.config.port, hostname: DEV_HOST }), config, agents]
  )
}
