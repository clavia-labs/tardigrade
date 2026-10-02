import { RuntimeError } from "@clavia/tardigrade-core"
import { Effect, Layer, Schema } from "effect"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { liveModelServices, modelInfo, modelActs } from "@clavia/tardigrade-agent/services/model"
import { askPermission } from "@clavia/tardigrade-agent/services/decisions"
import { fetch, workspace, memoryWorkspace } from "@clavia/tardigrade-libraries"
import { bunPromises, bunIsolate } from "@clavia/tardigrade-platform/bun"
import { ModelLock, lockedModelConfigOf, modelLockService, parseModelLock, MODEL_LOCK_FILE } from "@clavia/tardigrade-model/lock"
import { modelCredentialsFrom } from "@clavia/tardigrade-model/config"
import { codeModeActs } from "@clavia/tardigrade-agent/services/code-mode"
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

export const services = (options: { readonly permissions?: Permissions; readonly label?: string } = {}) => (host: Parameters<Permissions["layer"]>[0]) => {
  const permissions = options.permissions ?? createPermissions({ interactive: false })
  const platform = Layer.mergeAll(
    modelServices,
    bunIsolate(),
    memoryWorkspace,
    permissions.layer(host, options.label ?? "Code agent"),
    bunPromises(host, { deliver: settlement => host.deliver(settlement.ref, [settlement]) }),
  )
  return Layer.mergeAll(modelInfo, modelActs, askPermission, codeModeActs([fetch(), workspace()])).pipe(Layer.provideMerge(platform))
}
