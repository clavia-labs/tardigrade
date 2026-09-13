import { Layer } from "effect"
import { BunHttpServer, BunRuntime, BunFileSystem } from "@effect/platform-bun"
import { assertSupportedBun } from "@clavia/tardigrade-bun/runtime"

import { projectConfigOf, projectConfigPathOf, readConfig } from "./config"
import { layerRuntimeModelLock, layerLockedServerModels } from "./catalog"
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
const models = layerLockedServerModels(config, process.env).pipe(Layer.provide(lock))

// The host is built from the same configuration the routes read, and closed with the scope the
// server runs in, so the process that stops listening stops writing (host.ts, layerThreads).
const inference = makeInferenceStream()
const threads = Layer.provide(layerThreads({ inferenceObserver: inference.observer }), models)

const main = Layer.provide(serve({ api: { inference } }), [BunHttpServer.layer({ port: config.port }), models, threads])

BunRuntime.runMain(Layer.launch(main))
