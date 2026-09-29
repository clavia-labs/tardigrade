import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { Effect, Layer, Schema } from "effect"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { liveModelServices } from "@clavia/tardigrade-experimental-agent/services/model"
import { assistantRuntime } from "@clavia/tardigrade-experimental-agent/services/runtime"
import type { ActService } from "@clavia/tardigrade-experimental-core"
import { askPermission } from "@clavia/tardigrade-experimental-agent/services/acts"
import { fetchPackage, workspace, agents } from "@clavia/tardigrade-experimental-packages"
import { receiveResolution } from "@clavia/tardigrade-experimental-agent/services/promises"
import { Actor } from "@clavia/tardigrade-experimental-host"
import { bunPromises } from "@clavia/tardigrade-experimental-platform/bun"
import { ModelLock, lockedModelConfigOf, modelLockService, parseModelLock, MODEL_LOCK_FILE } from "@clavia/tardigrade-model/lock"
import { modelCredentialsFrom } from "@clavia/tardigrade-model/config"
import { actor } from "./actor"
import { createPermissions, type Permissions } from "./permissions"

const Config = Schema.Struct({ vars: Schema.Struct({ TARDIGRADE_CONFIG: Schema.Struct({ models: Schema.Unknown }) }) })

const env = { ...process.env }
const modelServices = Layer.unwrap(Effect.gen(function* () {
  const configPath = resolve(env.TARDIGRADE_CONFIG_PATH?.trim() || fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)))
  const lockPath = join(dirname(configPath), MODEL_LOCK_FILE)
  if (!(yield* Effect.tryPromise({ try: () => Bun.file(configPath).exists(), catch: RuntimeError.from }))) return yield* Effect.fail(new RuntimeError(`Model configuration does not exist: ${configPath}`))
  if (!(yield* Effect.tryPromise({ try: () => Bun.file(lockPath).exists(), catch: RuntimeError.from }))) return yield* Effect.fail(new RuntimeError(`Model lock is missing: ${lockPath}. Run tdg models lock from ${dirname(configPath)}.`))
  const [configText, lockText] = yield* Effect.all([
    Effect.tryPromise({ try: () => Bun.file(configPath).text(), catch: RuntimeError.from }),
    Effect.tryPromise({ try: () => Bun.file(lockPath).text(), catch: RuntimeError.from }),
  ], { concurrency: "unbounded" })
  const raw = yield* Effect.try({ try: () => Bun.JSONC.parse(configText), catch: RuntimeError.from })
  const manifest = yield* Schema.decodeUnknownEffect(Config)(raw)
  return yield* Effect.try({
    try: () => {
      const definitions = parseModelLock(lockText, lockPath)
      const config = lockedModelConfigOf(manifest.vars.TARDIGRADE_CONFIG.models, definitions)
      const { providers: _providers, ...policy } = config
      const lock = Layer.succeed(ModelLock, modelLockService(definitions, policy))
      return liveModelServices({ credentials: modelCredentialsFrom(config, env) }).pipe(Layer.provideMerge(lock))
    },
    catch: RuntimeError.from,
  })
}))

export const DEFAULT_MAX_CHILD_DEPTH = 1

// services provides model access, local child actors, and promise delivery for each actor runtime.
export const services = (options: { readonly maxChildDepth?: number; readonly permissions?: Permissions; readonly label?: string } = {}) => {
  const permissions = options.permissions ?? createPermissions({ interactive: false })
  return assistantRuntime<ActService<"agent.permission.request">>({
  actor,
  packages: [fetchPackage(), workspace(), agents()],
  maxChildDepth: options.maxChildDepth ?? DEFAULT_MAX_CHILD_DEPTH,
  services: (context, host) => Layer.mergeAll(askPermission.pipe(Layer.provide(permissions.layer(host, `${options.label ?? "Agent"}${context.depth ? ` / child depth ${context.depth}` : ""}`))), modelServices, Layer.unwrap(Effect.map(Actor, actor => bunPromises(host, {
    poll: actor.poll,
    deliver: settlement => receiveResolution(host, settlement),
  })))),
}).services
}
