import { Layer } from "effect"
import { BunFileSystem, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { assertSupportedBun } from "tardie/bun/runtime"
import { layerModelCatalog } from "tardie/server/catalog"
import { layerFileModelCatalogRepository } from "tardie/server/catalog-repository"
import { layerConfig, projectConfigOf, readConfig } from "tardie/server/config"
import { layerActorThreads } from "tardie/server/host"
import { serve } from "tardie/server/http"
import { makeInferenceStream } from "tardie/server/inference-stream"

import definition from "./actor"

assertSupportedBun()

const projectFile = Bun.file(new URL("wrangler.jsonc", import.meta.url))
const project = projectConfigOf(Bun.JSONC.parse(await projectFile.text()))
const config = readConfig(process.env, project)
const configLayer = layerConfig(config)
const catalogRepository = layerFileModelCatalogRepository(config.catalog.cachePath).pipe(
  Layer.provide(BunFileSystem.layer)
)
const catalog = Layer.provide(layerModelCatalog(), [configLayer, catalogRepository])
const inference = makeInferenceStream()
const threads = Layer.provide(
  layerActorThreads(definition, { inferenceObserver: inference.observer }),
  [configLayer, catalog]
)
const application = Layer.provide(
  serve({ api: { inference } }),
  [BunHttpServer.layer({ port: config.port }), configLayer, threads, catalog]
)

BunRuntime.runMain(Layer.launch(application))
