import { Layer } from "effect"
import { BunFileSystem, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { assertSupportedBun } from "@clavia/tardigrade-core/runtime"

import { layerFromEnv, readConfig } from "./config"
import { layerModelCatalog } from "./catalog"
import { layerFileModelCatalogRepository } from "./catalog-repository"
import { layerThreads } from "./host"
import { serve } from "./http"

// The entry point: environment to configuration to a listening Bun process. It holds no logic of
// its own, so anything worth testing lives in config.ts or http.ts and is exercised without a
// process (http.test.ts).

// The process refuses to listen on a runtime the framework cannot keep its promises on, rather than
// failing later inside a turn (packages/core/src/runtime.ts).
assertSupportedBun()

const config = readConfig(process.env)

const configLayer = layerFromEnv(process.env)

const catalogRepository = layerFileModelCatalogRepository(config.catalog.cachePath).pipe(Layer.provide(BunFileSystem.layer))
const catalog = Layer.provide(layerModelCatalog(), [configLayer, catalogRepository])

// The host is built from the same configuration the routes read, and closed with the scope the
// server runs in, so the process that stops listening stops writing (host.ts, layerThreads).
const threads = Layer.provide(layerThreads(), configLayer)

const main = Layer.provide(serve(), [BunHttpServer.layer({ port: config.port }), configLayer, threads, catalog])

BunRuntime.runMain(Layer.launch(main))
