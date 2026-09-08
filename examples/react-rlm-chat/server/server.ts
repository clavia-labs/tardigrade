import { join } from "node:path"
import { Effect, Layer } from "effect"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import { FetchHttpClient } from "effect/unstable/http"
import { createHost, serve } from "tardie/bun"
import { modelLayer } from "tardie/model/host"
import { modelAdapters } from "tardie/model/adapter"
import { openAICompatibleAdapter } from "tardie/model/openai"
import { catalogDiscoveryOf } from "tardie/http/models"
import { ModelCatalogStore, layerModelCatalog } from "tardie/server/catalog"
import { layerFileModelCatalogRepository } from "tardie/server/catalog-repository"
import { layerConfig, projectConfigOf, readConfig } from "tardie/server/config"
import { makeInferenceStream } from "tardie/http/inference-stream"

import definition from "./actor"

const projectFile = Bun.file(new URL("wrangler.jsonc", import.meta.url))
const project = projectConfigOf(Bun.JSONC.parse(await projectFile.text()))
const config = readConfig(process.env, project)
const configLayer = layerConfig(config)
const catalogRepository = layerFileModelCatalogRepository(config.catalog.cachePath).pipe(
  Layer.provide(BunFileSystem.layer)
)
const catalog = Layer.provide(layerModelCatalog(), [configLayer, catalogRepository])
const snapshot = await Effect.runPromise(ModelCatalogStore.pipe(Effect.provide(catalog)))
const inference = makeInferenceStream()
const layers = Layer.mergeAll(
  modelLayer(config, snapshot, modelAdapters(openAICompatibleAdapter), inference.observer),
  BunFileSystem.layer,
  BunPath.layer,
  FetchHttpClient.layer
)
const storage = config.db === ":memory:" ? ":memory:" : `${config.db}.actors`
const host = await createHost({
  actor: definition,
  storage,
  storageLayout: {
    databaseFor: (instance) => storage === ":memory:"
      ? ":memory:"
      : join(storage, `${Buffer.from(instance, "utf8").toString("base64url")}.sqlite`),
    instanceFromFile: (file) => file.endsWith(".sqlite")
      ? Buffer.from(file.slice(0, -7), "base64url").toString("utf8")
      : undefined
  },
  driver: { maxConcurrentThreads: config.maxConcurrentThreads },
  layersFor: () => layers
})

try {
  const server = await serve(host, {
    port: config.port,
    api: { inference, catalog: catalogDiscoveryOf(snapshot, config.model, config.modelCredentials) },
    ...(config.token === undefined ? {} : { token: config.token })
  })
  try {
    console.log(`Recursive Chat listening at ${server.url}`)
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop)
        process.off("SIGTERM", stop)
        resolve()
      }
      process.once("SIGINT", stop)
      process.once("SIGTERM", stop)
    })
  } finally {
    await server.close()
  }
} finally {
  await host.close()
}
