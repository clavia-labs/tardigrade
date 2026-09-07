import { Layer, ManagedRuntime } from "effect"
import { BunHttpServer } from "@effect/platform-bun"
import { HttpServer } from "effect/unstable/http"
import { serve as serveHttp } from "@clavia/tardigrade-http/http"
import { layerConfig, readConfig, type ServerConfigValue } from "@clavia/tardigrade-http/config"
import { ModelCatalogStore, type ModelCatalogState } from "@clavia/tardigrade-http/catalog"
import type { ApiOptions } from "@clavia/tardigrade-http/api"
import type { ActorMethods } from "@clavia/tardigrade-core/actor/method"
import { hostBackend, type Host } from "./create-host"

export const DEFAULT_HOST_IDLE_TIMEOUT_SECONDS = 10
export const DEFAULT_HOST_PORT = 4242
export const DEFAULT_HOST_HOSTNAME = "127.0.0.1"

export interface ServeOptions {
  readonly idleTimeoutSeconds?: number
  readonly port?: number
  readonly hostname?: string
  readonly token?: string
  readonly config?: ServerConfigValue
  readonly catalog?: ModelCatalogState
  readonly api?: ApiOptions
  readonly disableLogger?: boolean
}

// serve exposes a Bun host through the shared Effect HTTP application.
export const serve = async <Methods extends ActorMethods>(host: Host<Methods>, options: ServeOptions = {}) => {
  const config = options.config ?? readConfig({})
  const application = serveHttp({ disableLogger: options.disableLogger ?? true, disableListenLog: true, ...(options.api === undefined ? {} : { api: options.api }) }).pipe(
    Layer.provide([
      Layer.succeedContext(hostBackend(host).http),
      layerConfig({ ...config, ...(options.token === undefined ? {} : { token: options.token }) }),
      Layer.succeed(ModelCatalogStore, options.catalog ?? {})
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
    if (address._tag !== "TcpAddress") throw new Error("Bun HTTP server did not bind a TCP address")
    return { url: new URL(`http://${address.hostname}:${address.port}`), port: address.port, close: () => runtime.dispose() }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}
