import { Layer } from "effect"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { assertSupportedBun } from "@clavia/tardigrade-bun/runtime"

import { layerConfig } from "./config"
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
const lock = services.lock
const threads = Layer.provide(layerThreads({ infer: services.layers }), [configLayer, lock])

const main = Layer.provide(serve({ api }), [BunHttpServer.layer({ port: config.port }), configLayer, threads, lock])

BunRuntime.runMain(Layer.launch(main))
