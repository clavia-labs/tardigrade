import { bunHttpServices } from "@clavia/tardigrade-bun/http-threads"
import { ActorPushRefused, Threads, type ActorThreads } from "@clavia/tardigrade-http/threads"
import { modelLayer, modelIsConfigured, selectedModelFrom } from "@clavia/tardigrade-model/host"
export { selectedModelFrom, modelIsConfigured, MISSING_MODEL } from "@clavia/tardigrade-model/host"
import { createHost, hostBackend, type HostOptions, type Host } from "@clavia/tardigrade-bun/create-host"
import { Context, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import { createHash } from "node:crypto"
import { watch, type FSWatcher } from "node:fs"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Ingress, ingressFrom, type IngressActor } from "@clavia/tardigrade-host/transport/ingress"
import type { Provider } from "@clavia/tardigrade-host/transport/provider"
import {
  applyModelPolicy,
  ACTOR_ARTIFACT_VERSION,
  ACTOR_NAME_PATTERN,
  Infer,
  actorMethodsOf,
  type ActorMethods,
  type InferenceObserver,
  type ActorArtifactManifest,
  type Actor
} from "tardie"
import { type BunHostOptions } from "@clavia/tardigrade-bun/host"
import { ThreadAllocator } from "@clavia/tardigrade-core/actor/allocation"
import { openBunActorRegistry } from "@clavia/tardigrade-bun/registry"
import { modelAdapters, type ModelAdapter, type ModelAdapterRegistry } from "@clavia/tardigrade-model/adapter"
import {
  RESERVED_ACTOR,
  type ActorArtifact,
  type ActorSummary
} from "@clavia/tardigrade-client/contract"

import { builtInActor, type ServerR } from "./actor"
import { ServerConfig, type ServerConfigValue } from "./config"
import { ModelCatalogStore, type ModelCatalogState } from "./catalog"
import { providerAvailabilitiesOf } from "./catalog-availability"
import { modelsPageOf, providersPageOf } from "./catalog-page"
import { DriverGauge } from "./driver-gauge"

const serverModelAdaptersFor = async (config: ServerConfigValue): Promise<ModelAdapterRegistry> => {
  const protocols = new Set(Object.values(config.model.providers).map((provider) => provider.protocol))
  const selected: Array<ModelAdapter> = []
  if (protocols.has("openai-responses") || protocols.has("openai-chat-completions")) {
    selected.push(await import("@clavia/tardigrade-model/openai").then((module) => module.openAICompatibleAdapter))
  }
  if (protocols.has("anthropic-messages")) {
    selected.push(await import("@clavia/tardigrade-model/anthropic").then((module) => module.anthropicAdapter))
  }
  if (protocols.has("bedrock-converse")) {
    try {
      const module = await import("@clavia/tardigrade-model/bedrock")
      selected.push(await module.bedrockAdapterForBun())
    } catch (cause) {
      throw new Error(
        "model protocol \"bedrock-converse\" requires the optional Bedrock provider dependencies; install @aws-sdk/client-bedrock-runtime, @smithy/fetch-http-handler, @smithy/node-http-handler, and @tanstack/ai-bedrock",
        { cause }
      )
    }
  }
  const adapters = modelAdapters(...selected)
  for (const protocol of protocols) adapters.resolve(protocol)
  return adapters
}

// ActorPushRefused is why a pushed actor was not accepted, in the sentence the route prints. The
// artifact checks and the swap both raise it, so a caller reads one failure rather than telling a
// validation `Error` apart from a filesystem one by its message (api.ts, pushActor).
export { ActorPushRefused, Threads, type ActorThreads } from "@clavia/tardigrade-http/threads"
// The thread environment: everything the assembly needs that the bun host does not bind. The model
// binding is one of them, and so are the platform services the files and fetch packages reach
// through, bound here to their bun implementations. The union comes off the assembly's own type
// (actor.ts, ServerR), so a package added to the assembly is a compile error here until it is bound.
const layerThread = (
  config: ServerConfigValue,
  catalog: ModelCatalogState,
  options: ThreadsOptions,
  adapters: ModelAdapterRegistry
) =>
  Layer.mergeAll(
    options.infer ?? modelLayer(config, catalog, adapters, options.inferenceObserver),
    BunFileSystem.layer,
    BunPath.layer,
    FetchHttpClient.layer
  )

export interface ThreadsOptions {
  readonly allocation?: BunHostOptions<never>["allocation"]
  readonly threadAllocator?: typeof ThreadAllocator.Service
  // The model seam. Absent, the binding is derived from ServerConfig; present, it replaces that
  // derivation whole, which is how a test runs a scripted mind with no credentials
  // (host.test.ts). It is the one seam because Infer is the one place a turn leaves the process.
  readonly infer?: Layer.Layer<Infer>
  // modelAdapters replaces the host's protocol implementations and must cover every configured provider.
  readonly modelAdapters?: ModelAdapterRegistry
  // inferenceObserver receives ephemeral normalized text outside the durable event log.
  readonly inferenceObserver?: InferenceObserver
  // providers interpret replies whose durable inbound link targets an external provider instance.
  readonly providers?: ReadonlyArray<Provider>
  // actorRefresh watches the actor root and reconciles its artifacts after the stated debounce.
  // Absent keeps a hosted server's registry fixed except for PUT /v1/actors; tdg dev supplies it.
  readonly actorRefresh?: {
    readonly debounceMillis: number
    readonly onError?: ((error: Error) => void) | undefined
  } | undefined
}

interface LoadedActor {
  readonly summary: ActorSummary
  readonly host: Host<ActorMethods>
  readonly threads: ActorThreads
}

const digestOf = (module: string): string =>
  `sha256:${createHash("sha256").update(module).digest("hex")}`

const definitionOf = async (modulePath: string, expected: ActorArtifactManifest): Promise<Actor<ServerR>> => {
  const loaded: unknown = await import(`${pathToFileURL(modulePath).href}?digest=${encodeURIComponent(expected.digest)}`)
  const definition = (loaded as { readonly default?: unknown }).default
  if (typeof definition !== "object" || definition === null) {
    throw new Error("actor artifact must default export actor({ name, methods, components })")
  }
  const candidate = definition as Partial<Actor<ServerR>>
  if (candidate.name !== expected.name || !ACTOR_NAME_PATTERN.test(expected.name)) {
    throw new Error(`actor artifact name does not match ${JSON.stringify(expected.name)}`)
  }
  if (
    !Array.isArray(candidate.components)
  ) {
    throw new Error("actor artifact does not contain an Actor")
  }
  if (typeof candidate.methods !== "object" || candidate.methods === null || Array.isArray(candidate.methods)) {
    throw new Error("actor artifact does not declare its methods")
  }
  actorMethodsOf(candidate.methods as ActorMethods)
  return candidate as Actor<ServerR>
}

export type ActorApplicationRequirements<R> = Exclude<R, ServerR>

// ActorThreadLayerContext identifies the actor instance and thread receiving application services.
export interface ActorThreadLayerContext {
  readonly actorInstance: string
  readonly thread: string
}

export type ActorThreadLayersFor<R> = (
  context: ActorThreadLayerContext
) => Layer.Layer<ActorApplicationRequirements<R>>

type ActorThreadsBaseOptions = Pick<ThreadsOptions, "infer" | "inferenceObserver" | "modelAdapters" | "providers" | "threadAllocator" | "allocation">

export type ActorThreadsOptions<R> = ActorThreadsBaseOptions & ([ActorApplicationRequirements<R>] extends [never]
  ? { readonly layersFor?: ActorThreadLayersFor<R> }
  : { readonly layersFor: ActorThreadLayersFor<R> })

type ActorThreadsArguments<R> = [ActorApplicationRequirements<R>] extends [never]
  ? [options?: ActorThreadsOptions<R>]
  : [options: ActorThreadsOptions<R>]

const actorDatabasePath = (database: string, actor: string): string =>
  database === ":memory:"
    ? ":memory:"
    : join(`${database}.actors`, `${Buffer.from(actor, "utf8").toString("base64url")}.sqlite`)

const actorIdFromDatabase = (file: string): string | undefined => {
  if (!file.endsWith(".sqlite")) return undefined
  try {
    return Buffer.from(file.slice(0, -7), "base64url").toString("utf8")
  } catch {
    return undefined
  }
}

const mountedHost = async <R>(definition: Actor<R>, config: ServerConfigValue, thread: ReturnType<typeof layerThread>, options: ActorThreadsOptions<R>, database?: string) => {
  const host = await createHost<R, ActorMethods>({
    actor: definition,
    storage: config.db === ":memory:" ? ":memory:" : database === undefined ? `${config.db}.actors` : config.actorData,
    storageLayout: {
      databaseFor: (instance) => database ?? actorDatabasePath(config.db, instance),
      instanceFromFile: (file) => database === undefined ? actorIdFromDatabase(file) : file === `${definition.name}.sqlite` ? definition.name : undefined
    },
    providers: options.providers ?? [],
    driver: { maxConcurrentThreads: config.maxConcurrentThreads },
    ...(options.allocation === undefined ? {} : { allocation: options.allocation }),
    ...(options.threadAllocator === undefined ? {} : { threadAllocator: options.threadAllocator }),
    layersFor: (candidate: string, actorInstance: string) => {
      const application = options.layersFor?.({ actorInstance, thread: candidate })
      return application === undefined ? thread : Layer.mergeAll(thread, application)
    }
  } as HostOptions<R, ActorMethods>)
  return host
}

// layerActorThreads mounts a hydrated host in the server scope.
export const layerActorThreads = <R>(
  definition: Actor<R>,
  ...[options = {} as ActorThreadsOptions<R>]: ActorThreadsArguments<R>
): Layer.Layer<Threads | Ingress | DriverGauge, never, ServerConfig | ModelCatalogStore> =>
  Layer.effectContext(Effect.gen(function*() {
    const config = yield* ServerConfig
    const catalog = yield* ModelCatalogStore
    const adapters = options.modelAdapters ?? (yield* Effect.promise(() => serverModelAdaptersFor(config)))
    for (const provider of Object.values(config.model.providers)) adapters.resolve(provider.protocol)
    const host = yield* Effect.acquireRelease(
      Effect.promise(() => mountedHost(definition, config, layerThread(config, catalog, options, adapters), options)),
      (host) => Effect.promise(host.close)
    )
    return bunHttpServices(host)
  }))

const manifestOf = async (directory: string): Promise<{ readonly manifest: ActorArtifactManifest; readonly module: string }> => {
  const raw = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Partial<ActorArtifactManifest>
  if (raw.schema !== ACTOR_ARTIFACT_VERSION) {
    throw new Error(`unsupported actor artifact schema ${String(raw.schema)} in ${directory}`)
  }
  if (
    typeof raw.name !== "string" ||
    typeof raw.module !== "string" ||
    typeof raw.digest !== "string"
  ) {
    throw new Error(`invalid actor manifest in ${directory}`)
  }
  const manifest = raw as ActorArtifactManifest
  const module = await readFile(join(directory, manifest.module), "utf8")
  const actual = digestOf(module)
  if (actual !== manifest.digest) throw new Error(`actor artifact digest mismatch for ${manifest.name}`)
  return { manifest, module }
}

// make builds one isolated host per actor and returns their shared HTTP-facing registry.
const make = (options: ThreadsOptions) =>
  Effect.gen(function*() {
    const config = yield* ServerConfig
    const catalog = yield* ModelCatalogStore
    const adapters = options.modelAdapters ?? (yield* Effect.promise(() => serverModelAdaptersFor(config)))
    for (const provider of Object.values(config.model.providers)) adapters.resolve(provider.protocol)
    const thread = layerThread(config, catalog, options, adapters)
    const runtimes = new Map<string, LoadedActor>()
    const registry = yield* openBunActorRegistry<ActorSummary>({ file: config.db })
    const runRegistry = Effect.runPromiseWith(yield* Effect.context<never>())
    const snapshot = catalog.snapshot
    const availability = providerAvailabilitiesOf(config.model, config.modelCredentials)
    const agentCatalog = snapshot === undefined
      ? undefined
      : {
          providers: (query: Parameters<typeof providersPageOf>[2]) => {
            const models = applyModelPolicy(config.model, query?.models ?? {})
            return providersPageOf(snapshot, availability, { ...query, models, policy: models })
          },
          models: (query: Parameters<typeof modelsPageOf>[2]) => {
            const models = applyModelPolicy(config.model, query?.models ?? {})
            return modelsPageOf(snapshot, availability, { ...query, models, policy: models })
          }
        }
    const builtIn = modelIsConfigured(config)
      ? builtInActor({
          contextWindowTokens: (model) => selectedModelFrom(config.model, config.modelCredentials, catalog, model).contextWindowTokens,
          ...(agentCatalog === undefined ? {} : { catalog: agentCatalog })
        })
      : builtInActor(agentCatalog === undefined ? {} : { catalog: agentCatalog })
    const builtInSummary: ActorSummary = { name: RESERVED_ACTOR, builtIn: true }
    const root = resolve(config.actors)
    let mutations: Promise<void> = Promise.resolve()
    const exclusive = <A>(operation: () => Promise<A>): Promise<A> => {
      const result = mutations.then(operation, operation)
      mutations = result.then(() => undefined, () => undefined)
      return result
    }
    const open = async (summary: ActorSummary, definition: Actor<ServerR>, database: string): Promise<LoadedActor> => {
      const host = await mountedHost(definition, config, thread, options, database)
      try {
        const threads = await runRegistry(Context.get(bunHttpServices(host), Threads).ensure(summary.name))
        const loaded = { summary, host, threads }
        await runRegistry(registry.put(summary))
        runtimes.set(summary.name, loaded)
        return loaded
      } catch (error) { await host.close(); throw error }
    }
    const builtInHost = yield* Effect.acquireRelease(
      Effect.promise(() => mountedHost(builtIn, config, thread, options)),
      (host) => Effect.promise(host.close)
    )
    const builtInServices = bunHttpServices(builtInHost)
    const builtInThreads = Context.get(builtInServices, Threads)
    const load = async (directory: string): Promise<{ readonly summary: ActorSummary; readonly definition: Actor<ServerR> }> => {
      const artifact = await manifestOf(directory)
      if (artifact.manifest.name === RESERVED_ACTOR) throw new Error(`${RESERVED_ACTOR} is reserved for the built-in actor`)
      const definition = await definitionOf(join(directory, artifact.manifest.module), artifact.manifest)
      return {
        summary: { name: definition.name, builtIn: false, digest: artifact.manifest.digest },
        definition
      }
    }
    const replace = async (summary: ActorSummary, definition: Actor<ServerR>): Promise<void> => {
      const current = runtimes.get(summary.name)
      if (current?.summary.digest === summary.digest) return
      if (current !== undefined) {
        await current.host.close()
        runtimes.delete(summary.name)
      }
      await open(summary, definition, join(resolve(config.actorData), `${summary.name}.sqlite`))
    }
    const synchronize = async (): Promise<void> => {
      const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []
        throw error
      })
      const found = new Set<string>()
      for (const entry of entries) {
        if (!entry.isDirectory() || !ACTOR_NAME_PATTERN.test(entry.name)) continue
        const loaded = await load(join(root, entry.name))
        if (loaded.summary.name !== entry.name) throw new Error(`actor artifact name does not match directory ${JSON.stringify(entry.name)}`)
        found.add(loaded.summary.name)
        await replace(loaded.summary, loaded.definition)
      }
      for (const [name, runtime] of runtimes) {
        if (name === RESERVED_ACTOR || found.has(name)) continue
        await runtime.host.close()
        runtimes.delete(name)
        await runRegistry(registry.remove(name))
      }
      for (const registration of await runRegistry(registry.list)) {
        if (registration.name !== RESERVED_ACTOR && !runtimes.has(registration.name)) {
          await runRegistry(registry.remove(registration.name))
        }
      }
    }
    let watcher: FSWatcher | undefined
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      watcher?.close()
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
      await mutations
      await Promise.all([...runtimes.values()].map((runtime) => runtime.host.close()))
    }))
    yield* Effect.promise(async () => {
      await runRegistry(registry.put(builtInSummary))
      await synchronize()
      if (options.actorRefresh !== undefined) {
        const { debounceMillis } = options.actorRefresh
        if (!Number.isInteger(debounceMillis) || debounceMillis < 0) {
          throw new Error(`actor refresh debounce must be a non-negative integer, got ${debounceMillis}`)
        }
        await mkdir(root, { recursive: true })
        const report = options.actorRefresh.onError ?? ((error: Error) => console.error(`actor refresh failed: ${error.message}`))
        watcher = watch(root, () => {
          if (refreshTimer !== undefined) clearTimeout(refreshTimer)
          refreshTimer = setTimeout(() => {
            refreshTimer = undefined
            void exclusive(synchronize).catch((error: unknown) => report(error instanceof Error ? error : new Error(String(error))))
          }, debounceMillis)
        })
      }
    })

    const selected = (name: string): Effect.Effect<ActorThreads | undefined> =>
      registry.resolve(name).pipe(Effect.map((registration) => registration === undefined ? undefined : runtimes.get(name)?.threads))
    const push = (artifact: ActorArtifact): Effect.Effect<ActorSummary, ActorPushRefused> =>
      Effect.tryPromise({
        try: () => exclusive(async () => {
          const manifest = artifact.manifest as ActorArtifactManifest
          if (manifest.schema !== ACTOR_ARTIFACT_VERSION) throw new Error(`unsupported actor artifact schema ${manifest.schema}`)
          if (!ACTOR_NAME_PATTERN.test(manifest.name)) throw new Error(`actor name must match ${String(ACTOR_NAME_PATTERN)}`)
          if (manifest.name === RESERVED_ACTOR) throw new Error(`${RESERVED_ACTOR} is reserved for the built-in actor`)
          if (manifest.module !== "actor.mjs") throw new Error(`actor module must be ${JSON.stringify("actor.mjs")}`)
          const actual = digestOf(artifact.module)
          if (actual !== manifest.digest) throw new Error(`actor artifact digest mismatch: expected ${manifest.digest}, got ${actual}`)
          const destination = join(root, manifest.name)
          const temporary = `${destination}.incoming`
          const previous = `${destination}.previous`
          await mkdir(root, { recursive: true })
          await rm(temporary, { recursive: true, force: true })
          await rm(previous, { recursive: true, force: true })
          await mkdir(temporary, { recursive: true })
          await writeFile(join(temporary, manifest.module), artifact.module, "utf8")
          await writeFile(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
          const definition = await definitionOf(join(temporary, manifest.module), manifest)
          const current = runtimes.get(manifest.name)
          if (current !== undefined) {
            await current.host.close()
            runtimes.delete(manifest.name)
          }
          const summary: ActorSummary = { name: manifest.name, builtIn: false, digest: manifest.digest }
          try {
            await open(summary, definition, join(resolve(config.actorData), `${manifest.name}.sqlite`))
            try {
              await rename(destination, previous)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            }
            await rename(temporary, destination)
            await rm(previous, { recursive: true, force: true })
            return summary
          } catch (error) {
            await rm(temporary, { recursive: true, force: true })
            throw error
          }
        }),
        catch: (error) => new ActorPushRefused({ message: error instanceof Error ? error.message : String(error), cause: error })
      })

    const service: Context.Service.Shape<typeof Threads> = {
      ...builtInThreads,
      definitions: registry.list,
      definition: selected,
      pushDefinition: push
    }
    const ingress = ingressFrom({ resolve: (target) => {
      const host = target.actor === RESERVED_ACTOR ? builtInHost : runtimes.get(target.actor)?.host
      return host === undefined ? Effect.succeed(undefined as IngressActor | undefined) : hostBackend(host).resolve(target.actor === RESERVED_ACTOR ? target : { ...target, instance: host.actor })
    } })
    const gauges = () => [builtInHost, ...[...runtimes.values()].map((loaded) => loaded.host)].map((host) => Context.get(bunHttpServices(host), DriverGauge))
    const gauge: Context.Service.Shape<typeof DriverGauge> = {
      resting: Effect.suspend(() => Effect.map(Effect.all(gauges().map((gauge) => gauge.resting)), (values) => values.every(Boolean))),
      dirty: Effect.suspend(() => Effect.map(Effect.all(gauges().map((gauge) => gauge.dirty)), (values) => values.reduce((sum, value) => sum + value, 0)))
    }
    return Context.make(Threads, service).pipe(
      Context.add(Ingress, ingress),
      Context.add(DriverGauge, gauge)
    )
  })

// layerThreads loads actor definitions and exposes their hosts to HTTP (host.test.ts).
export const layerThreads = (options: ThreadsOptions = {}): Layer.Layer<Threads | Ingress | DriverGauge, never, ServerConfig | ModelCatalogStore> =>
  Layer.effectContext(make(options))
