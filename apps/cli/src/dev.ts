import { Console, Context, Effect, Layer } from "effect"
import { createServer } from "node:net"
import { HttpRouter, HttpServer, HttpStaticServer } from "effect/unstable/http"
import { BunFileSystem, BunHttpServer } from "@effect/platform-bun"
import { layerConfig, type ServerConfigValue } from "@clavia/tardigrade-server/config"
import { layerModelCatalog, ModelCatalogStore } from "@clavia/tardigrade-server/catalog"
import { layerFileModelCatalogRepository } from "@clavia/tardigrade-server/catalog-repository"
import { layerThreads, type ThreadsOptions } from "@clavia/tardigrade-server/host"
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

// DEV_URL_HOST is the hostname shown to a person and opened in their browser. The listening
// interface remains DEV_HOST (dev.test.ts, "the API answers without a token, on loopback").
export const DEV_URL_HOST = "localhost"

// DEFAULT_MIN_PORT is the lowest automatic fallback `tdg dev` tries when its implicit default is
// occupied. The `--min-port` flag lets a caller narrow this range.
export const DEFAULT_MIN_PORT = 1024

// DEFAULT_ACTOR_REFRESH_MILLIS lets an atomic local push finish its directory swaps before tdg dev
// reconciles the actor root. DevOptions and --actor-refresh-ms can replace it.
export const DEFAULT_ACTOR_REFRESH_MILLIS = 50

// The status that means the router matched nothing. It is the seam the UI is served through: the
// declared routes answer first, and only a path none of them owns reaches the build.
export const UNMATCHED = 404

export type BrowserPlatform = "darwin" | "linux" | "win32"

// browserCommand returns the operating system command that opens an HTTP URL in the default
// browser.
export const browserCommand = (url: string, platform: BrowserPlatform = process.platform as BrowserPlatform): Array<string> =>
  platform === "darwin"
    ? ["open", url]
    : platform === "win32"
    ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url]

// openBrowser opens a URL and reports a launcher failure after the operating system command exits.
export const openBrowser = async (url: string): Promise<void> => {
  const command = browserCommand(url)
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  const code = await child.exited
  if (code !== 0) throw new Error(`${command[0]} exited ${code}`)
}

export type PortAvailable = (port: number, host: string) => Promise<boolean>

// portIsAvailable probes one loopback port before the application layer starts listening.
export const portIsAvailable: PortAvailable = (port, host) =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false)
      else reject(error)
    })
    server.once("listening", () => {
      server.close((error) => error === undefined ? resolve(true) : reject(error))
    })
    server.listen({ port, host, exclusive: true })
  })

// availableDevPort returns the first available port at or below preferred, down to minimum.
export const availableDevPort = async (
  preferred: number,
  minimum: number = DEFAULT_MIN_PORT,
  available: PortAvailable = portIsAvailable
): Promise<number> => {
  if (!Number.isInteger(minimum) || minimum < 0 || minimum > preferred) {
    throw new Error(`--min-port must be an integer between 0 and ${preferred}, got ${minimum}`)
  }
  for (let candidate = preferred; candidate >= minimum; candidate--) {
    if (await available(candidate, DEV_HOST)) return candidate
  }
  throw new Error(`no available port between ${minimum} and ${preferred}`)
}

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
  // The model seam, which a test binds to a scripted mind (apps/server/src/host.ts, ThreadsOptions).
  readonly threads?: ThreadsOptions | undefined
  // catalog replaces the startup-refreshed public model catalog for an embedding or test.
  readonly catalog?: Layer.Layer<ModelCatalogStore> | undefined
  // actorRefreshMillis is the visible debounce applied to local actor-root changes.
  readonly actorRefreshMillis?: number | undefined
  readonly disableLogger?: boolean | undefined
  readonly disableListenLog?: boolean | undefined
  // onListen receives the UI URL after the server owns its listening socket.
  readonly onListen?: ((url: string) => Promise<void>) | undefined
}

// dev is the whole command: resolve the build, open the store, listen on loopback. It answers a
// Layer rather than a running process, so the caller owns the scope and the process that stops
// listening stops writing (apps/server/src/host.ts, layerThreads).
export const dev = (options: DevOptions) => {
  const actorRefreshMillis = options.actorRefreshMillis ?? DEFAULT_ACTOR_REFRESH_MILLIS
  if (!Number.isInteger(actorRefreshMillis) || actorRefreshMillis < 0) {
    throw new Error(`actor refresh must be a non-negative integer, got ${actorRefreshMillis}`)
  }
  const root = resolveAssets(options.assets)
  const config = layerConfig(options.config)
  const catalogRepository = layerFileModelCatalogRepository(options.config.catalog.cachePath).pipe(
    Layer.provide(BunFileSystem.layer)
  )
  const catalog = options.catalog ?? Layer.provide(layerModelCatalog(), [config, catalogRepository])
  const threads = Layer.provide(layerThreads({
    ...options.threads,
    actorRefresh: { debounceMillis: actorRefreshMillis }
  }), config)
  // provideMerge rather than provide: the listening server stays visible in the layer's own
  // services, which is what lets a caller read the address it was given when it asked for port 0
  // (dev.test.ts).
  const running = Layer.provideMerge(
    HttpRouter.serve(Layer.mergeAll(layerApp(), layerVoyager(root)), {
      disableLogger: options.disableLogger ?? false,
      disableListenLog: options.disableListenLog ?? false
    }),
    [BunHttpServer.layer({ port: options.config.port, hostname: DEV_HOST }), config, threads, catalog]
  )
  if (options.onListen === undefined) return running
  return Layer.tap(running, (context) => {
    const server = Context.get(context, HttpServer.HttpServer)
    const address = server.address
    const port = address._tag === "TcpAddress" ? address.port : options.config.port
    const url = `http://${DEV_URL_HOST}:${port}`
    return Effect.tryPromise(() => options.onListen!(url)).pipe(
      Effect.catch((error) => Console.log(`could not open ${url}: ${String(error)}`))
    )
  })
}
