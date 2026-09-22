import { Effect, Layer } from "effect"
import { serve as serveHttp, layerApp as layerHttpApp } from "@clavia/tardigrade-http/http"
import { catalogDiscoveryOf } from "@clavia/tardigrade-http/models"
import type { ApiOptions } from "@clavia/tardigrade-http/api"
import { ServerConfig } from "./config"
import { ModelLock } from "@clavia/tardigrade-model/lock"
export * from "@clavia/tardigrade-http/http"

const httpOptions = (options?: ApiOptions) => Effect.gen(function* () {
  const config = yield* ServerConfig
  if (options?.catalog !== undefined) return { token: config.token, ...options }
  const lock = yield* Effect.serviceOption(ModelLock)
  const catalog = lock._tag === "None" ? {} : { snapshot: yield* Effect.promise(() => lock.value.listing()) }
  return { token: config.token, catalog: catalogDiscoveryOf(catalog, config.model, config.modelCredentials), ...options }
})

// layerApp supplies application authentication and model discovery to the HTTP routes (api.test.ts).
export const layerApp = (options?: ApiOptions) => Layer.unwrap(Effect.map(httpOptions(options), layerHttpApp))

// serve supplies application configuration to the shared HTTP server (api.test.ts).
export const serve = (options?: Parameters<typeof serveHttp>[0]) => Layer.unwrap(Effect.map(httpOptions(options?.api), (api) => serveHttp({ ...options, api })))
