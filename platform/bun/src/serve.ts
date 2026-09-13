import { bunHttpServices } from "./http-threads"
import { Layer, ManagedRuntime, Result } from "effect"
import * as NetAddress from "effect/unstable/net/NetAddress"
import { BunHttpServer } from "@effect/platform-bun"
import { HttpServer } from "effect/unstable/http"
import { serve as serveHttp } from "@clavia/tardigrade-http/http"
import type { ApiOptions } from "@clavia/tardigrade-http/api"
import type { ActorMethods } from "@clavia/tardigrade-core/actor/method"
import type { Host } from "./create-host"

export const DEFAULT_HOST_IDLE_TIMEOUT_SECONDS = 10
export const DEFAULT_HOST_PORT = 4242
export const DEFAULT_HOST_HOSTNAME = "127.0.0.1"

export interface ServeOptions {
  readonly idleTimeoutSeconds?: number
  readonly port?: number
  readonly hostname?: string
  readonly token?: string | undefined
  readonly api?: Omit<ApiOptions, "token">
  readonly disableLogger?: boolean
}

// serve exposes a Bun host through the shared Effect HTTP application.
export const serve = async <Methods extends ActorMethods>(host: Host<Methods>, options: ServeOptions = {}) => {
  const streams = new AbortController()
  const application = serveHttp({ disableLogger: options.disableLogger ?? true, disableListenLog: true, api: {
    token: options.token,
    ...options.api,
    streamShutdownSignal: options.api?.streamShutdownSignal === undefined
      ? streams.signal
      : AbortSignal.any([streams.signal, options.api.streamShutdownSignal])
  } }).pipe(
    Layer.provide([
      Layer.succeedContext(bunHttpServices(host))
    ]),
    Layer.provideMerge(BunHttpServer.layer({
      port: options.port ?? DEFAULT_HOST_PORT,
      hostname: options.hostname ?? DEFAULT_HOST_HOSTNAME,
      idleTimeout: options.idleTimeoutSeconds ?? DEFAULT_HOST_IDLE_TIMEOUT_SECONDS
    }))
  )
  const runtime = ManagedRuntime.make(application)
  try {
    const server = await runtime.runPromise(HttpServer.HttpServer)
    const address = server.address
    if (NetAddress.isUnixPathAddress(address)) throw new Error("Bun HTTP server did not bind a TCP address")
    return { url: Result.getOrThrow(NetAddress.toUrl(address)), port: address.port, close: () => { streams.abort(); return runtime.dispose() } }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}
