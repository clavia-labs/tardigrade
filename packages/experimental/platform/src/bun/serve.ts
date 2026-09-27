import { Layer, ManagedRuntime, Result } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import * as NetAddress from "effect/unstable/net/NetAddress"
import { BunHttpServer } from "@effect/platform-bun"
import { hostRoutes, type HttpHost } from "@clavia/tardigrade-experimental-host"

export const DEFAULT_SERVE_OPTIONS = { hostname: "127.0.0.1", port: 4242, idleTimeoutSeconds: 0 } as const
export interface ServeOptions {
  readonly hostname?: string
  readonly port?: number
  readonly idleTimeoutSeconds?: number
}
// serve binds the host to Effect HTTP; closing the server leaves host ownership with the caller.
export async function serve(host: HttpHost, options: ServeOptions = {}) {
  const runtime = ManagedRuntime.make(HttpRouter.serve(hostRoutes(host), { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(BunHttpServer.layer({
      hostname: options.hostname ?? DEFAULT_SERVE_OPTIONS.hostname,
      port: options.port ?? DEFAULT_SERVE_OPTIONS.port,
      idleTimeout: options.idleTimeoutSeconds ?? DEFAULT_SERVE_OPTIONS.idleTimeoutSeconds,
    })),
  ))
  try {
    const server = await runtime.runPromise(HttpServer.HttpServer)
    if (NetAddress.isUnixPathAddress(server.address)) throw new Error("Expected a TCP server")
    return { port: server.address.port, url: Result.getOrThrow(NetAddress.toUrl(server.address)), close: () => runtime.dispose() }
  } catch (error) { await runtime.dispose(); throw error }
}
