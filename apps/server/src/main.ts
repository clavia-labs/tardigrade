import { Layer } from "effect"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { assertSupportedBun } from "@clavia/tardigrade-bun/runtime"

import { layerConfig } from "./config"
import { ModelCatalogStore } from "./catalog"
import { bunModelServices } from "./model-services"
import { layerThreads } from "./host"
import { serve } from "./http"

// The entry point resolves project JSONC and the environment before starting a Bun process.

// The process refuses to listen on a runtime the framework cannot keep its promises on, rather than
// failing later inside a turn (platform/bun/src/runtime.ts).
assertSupportedBun()

const services = await bunModelServices({ env: process.env })
const { config, api } = services
const configLayer = layerConfig(config)
const catalog = Layer.succeed(ModelCatalogStore, services.catalog)
const threads = Layer.provide(layerThreads({ infer: services.layers }), [configLayer, catalog])

const main = Layer.provide(serve({ api }), [BunHttpServer.layer({ port: config.port }), configLayer, threads, catalog])

BunRuntime.runMain(Layer.launch(main))
