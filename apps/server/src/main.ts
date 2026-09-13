import { Layer } from "effect"
import { BunHttpServer, BunRuntime, BunFileSystem } from "@effect/platform-bun"
import { assertSupportedBun } from "@clavia/tardigrade-bun/runtime"

import { projectConfigOf, projectConfigPathOf, readConfig } from "./config"
import { layerModelCatalog, layerRuntimeModelLock, layerLockedServerConfig } from "./catalog"
import { layerThreads } from "./host"
import { serve } from "./http"
import { makeInferenceStream } from "./inference-stream"

// The entry point resolves project JSONC and the environment before starting a Bun process.

// The process refuses to listen on a runtime the framework cannot keep its promises on, rather than
// failing later inside a turn (platform/bun/src/runtime.ts).
assertSupportedBun()

const projectPath = projectConfigPathOf(process.env)
const projectFile = Bun.file(projectPath)
const projectExists = await projectFile.exists()
if (!projectExists && process.env.TARDIGRADE_CONFIG_PATH?.trim().length) {
  throw new Error(`TARDIGRADE_CONFIG_PATH names ${JSON.stringify(projectPath)}, but that file does not exist`)
}
const project = projectExists ? projectConfigOf(Bun.JSONC.parse(await projectFile.text())) : projectConfigOf({})
const config = readConfig(process.env, project)

const lock = layerRuntimeModelLock(config).pipe(Layer.provide(BunFileSystem.layer))
const configLayer = layerLockedServerConfig(config, process.env).pipe(Layer.provide(lock))

// The host is built from the same configuration the routes read, and closed with the scope the
// server runs in, so the process that stops listening stops writing (host.ts, layerThreads).
const catalog = Layer.provide(layerModelCatalog, [configLayer, lock])
const inference = makeInferenceStream()
const threads = Layer.provide(layerThreads({ inferenceObserver: inference.observer }), [configLayer, catalog])

const main = Layer.provide(serve({ api: { inference } }), [BunHttpServer.layer({ port: config.port }), configLayer, threads, catalog])

BunRuntime.runMain(Layer.launch(main))
