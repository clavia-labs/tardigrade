import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { Context, Effect, Layer, ManagedRuntime, Result } from "effect"
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
export function serve(host: HttpHost, options: ServeOptions = {}) {
  return Effect.gen(function* () {
    const runtime = ManagedRuntime.make(HttpRouter.serve(hostRoutes(host), { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(BunHttpServer.layer({
        hostname: options.hostname ?? DEFAULT_SERVE_OPTIONS.hostname,
        port: options.port ?? DEFAULT_SERVE_OPTIONS.port,
        idleTimeout: options.idleTimeoutSeconds ?? DEFAULT_SERVE_OPTIONS.idleTimeoutSeconds,
      })),
    ))
    return yield* Effect.gen(function* () {
      const context = yield* runtime.contextEffect
      const { address } = Context.get(context, HttpServer.HttpServer)
      if (NetAddress.isUnixPathAddress(address)) return yield* Effect.fail(new RuntimeError("Expected a TCP server"))
      const url = yield* Effect.try({ try: () => Result.getOrThrow(NetAddress.toUrl(address)), catch: RuntimeError.from })
      return { port: address.port, url, close: runtime.disposeEffect }
    }).pipe(Effect.onError(() => runtime.disposeEffect))
  })
}
