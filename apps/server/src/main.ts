import { Layer } from "effect"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { assertSupportedBun } from "@clavia/tardigrade-core/runtime"

import { layerFromEnv, readConfig } from "./config"
import { layerAgents } from "./host"
import { serve } from "./http"

// The entry point: environment to configuration to a listening Bun process. It holds no logic of
// its own, so anything worth testing lives in config.ts or http.ts and is exercised without a
// process (http.test.ts).

// The process refuses to listen on a runtime the framework cannot keep its promises on, rather than
// failing later inside a turn (packages/core/src/runtime.ts).
assertSupportedBun()

const config = readConfig(process.env)

const configLayer = layerFromEnv(process.env)

// The host is built from the same configuration the routes read, and closed with the scope the
// server runs in, so the process that stops listening stops writing (host.ts, layerAgents).
const agents = Layer.provide(layerAgents(), configLayer)

const main = Layer.provide(serve(), [BunHttpServer.layer({ port: config.port }), configLayer, agents])

BunRuntime.runMain(Layer.launch(main))
