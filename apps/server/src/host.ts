import { Clock, Context, Data, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import { createHash } from "node:crypto"
import { watch, type FSWatcher } from "node:fs"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { Event } from "@clavia/tardigrade-core/event"
import type { Envelope } from "@clavia/tardigrade-core/communication/envelope"
import type { Directory } from "@clavia/tardigrade-core/communication/directory"
import { Ingress, ingressFrom } from "@clavia/tardigrade-host/communication/ingress"
import type { Provider } from "@clavia/tardigrade-host/communication/provider"
import {
  ACTOR_ARTIFACT_VERSION,
  ACTOR_NAME_PATTERN,
  Infer,
  actorMethodsOf,
  type ActorMethods,
  type ModelCoordinate,
  type ActorArtifactManifest,
  type ActorDefinition
} from "tardie"
import type { Action } from "tardie/events"
import { createBunHost, type BunHost } from "@clavia/tardigrade-bun/host"
import { openBunActorRegistry } from "@clavia/tardigrade-bun/registry"
import { infer } from "@clavia/tardigrade-model/model"
import {
  RESERVED_ACTOR,
  type ActorArtifact,
  type ActorSummary,
  type ModelCatalog
} from "@clavia/tardigrade-client/contract"

import { builtInActor, type ServerR } from "./actor"
import { ServerConfig, type ModelConfig, type ModelCredentials, type ServerConfigValue } from "./config"
import { ModelCatalogStore, type ModelCatalogState } from "./catalog"
import { DriverGauge } from "./http"

// The durable host, the assembly it runs, and the loop that drives it, behind one service. The
// routes speak thread ids; the lane a host knows lives here and nowhere else, so a route can never
// name a lane and the store can never see an id.

// LANE_PREFIX is the id-to-lane map (apps-server-spec.md, "Resources"). A lane outside it belongs
// to something other than a thread and never appears in a listing. The prefix stays `ag.` while the
// API's noun is the thread, because the lane is where the agent assembly runs, and that assembly
// mints its own child lanes under the same prefix (packages/agent/src/spawn.ts, `sibling`). Renaming
// it would rename addresses a spawn already wrote into a durable log.
export const LANE_PREFIX = "ag."

export const laneOf = (id: string): string => `${LANE_PREFIX}${id}`

// idOf is laneOf's inverse, undefined for a lane this server does not own.
export const idOf = (lane: string): string | undefined =>
  lane.startsWith(LANE_PREFIX) ? lane.slice(LANE_PREFIX.length) : undefined

// ActorPushRefused is why a pushed actor was not accepted, in the sentence the route prints. The
// artifact checks and the swap both raise it, so a caller reads one failure rather than telling a
// validation `Error` apart from a filesystem one by its message (api.ts, pushActor).
export class ActorPushRefused extends Data.TaggedError("ActorPushRefused")<{
  readonly message: string
  readonly cause: unknown
}> {}

export interface ActorThreads {
  readonly methods: ActorMethods
  readonly append: (id: string, event: Event) => Effect.Effect<void>
  readonly events: (id: string) => Effect.Effect<ReadonlyArray<Event>>
  readonly list: Effect.Effect<ReadonlyArray<{ readonly id: string; readonly events: ReadonlyArray<Event> }>>
  readonly settled: Effect.Effect<void>
}

// Threads exposes the selected actor's method declarations beside its durable thread operations. Method meaning stays with the actor, while the service stores and returns its event log (packages/agent/src/method.ts, ActorMethodDeclaration).
export class Threads extends Context.Service<
  Threads,
  {
    readonly append: ActorThreads["append"]
    readonly methods: ActorThreads["methods"]
    readonly events: ActorThreads["events"]
    readonly list: ActorThreads["list"]
    // settled resolves once the drive in flight, and the follow-up it coalesced, has finished. A
    // client never waits on it (a delivery answers 202 and the client polls the turn); a test and
    // a shutdown do (host.test.ts).
    readonly settled: ActorThreads["settled"]
    readonly actors?: Effect.Effect<ReadonlyArray<ActorSummary>>
    readonly actor?: (name: string) => Effect.Effect<ActorThreads | undefined>
    readonly push?: (artifact: ActorArtifact) => Effect.Effect<ActorSummary, ActorPushRefused>
  }
>()("tardigrade/server/Threads") {}

// The model binding the configured coordinates name. Absent coordinates are not an endpoint this
// server invents: every attempt fails with what is missing, so the process still boots, still
// answers /healthz, and says why a turn cannot run (config.ts, ModelConfig).
export const MISSING_MODEL = "no model provider is configured: run `tdg setup`"

interface SelectedModel {
  readonly model_id: string
  readonly provider: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly protocol: NonNullable<ModelConfig["providers"][string]["protocol"]>
  readonly region?: string
  readonly contextWindowTokens: number
  readonly maxOutputTokens?: number
  readonly pricing?: import("tardie/usage").ModelPricing
  readonly catalogRevision: string
}

interface ProviderConnection {
  readonly baseUrl: string
  readonly apiKey: string
  readonly protocol: NonNullable<ModelConfig["providers"][string]["protocol"]>
  readonly region?: string
}

const connectionFrom = (
  config: ModelConfig,
  credentials: ModelCredentials,
  selected: ModelCoordinate
): ProviderConnection => {
  const provider = config.providers[selected.provider]
  if (provider === undefined) {
    const available = Object.keys(config.providers).sort()
    throw new Error(
      `provider ${JSON.stringify(selected.provider)} is not configured for model ${JSON.stringify(selected.model_id)}; ` +
      `run \`tdg setup\`${available.length === 0 ? "" : `; configured providers: ${available.join(", ")}`}`
    )
  }
  if (provider.baseUrl === undefined) throw new Error(`provider ${JSON.stringify(selected.provider)} has no base URL`)
  if (provider.protocol === undefined) throw new Error(`provider ${JSON.stringify(selected.provider)} has no protocol`)
  if (provider.env.length === 0) {
    throw new Error(`provider ${JSON.stringify(selected.provider)} names no credential environment variables; run \`tdg setup\``)
  }
  const apiKey = provider.env.flatMap((name) => credentials[name] === undefined ? [] : [credentials[name]!])[0]
  if (apiKey === undefined) {
    throw new Error(
      `provider ${JSON.stringify(selected.provider)} needs a credential; set ${provider.env.join(" or ")} as a secret environment variable`
    )
  }
  return {
    baseUrl: provider.baseUrl,
    apiKey,
    protocol: provider.protocol,
    ...(provider.region === undefined ? {} : { region: provider.region })
  }
}

const catalogModelFrom = (
  snapshot: ModelCatalog,
  selected: ModelCoordinate
): ModelCatalog["providers"][number]["models"][number] => {
  const provider = snapshot.providers.find((candidate) => candidate.id === selected.provider)
  if (provider === undefined) {
    throw new Error(
      `provider ${JSON.stringify(selected.provider)} is absent from model catalog revision ${JSON.stringify(snapshot.revision)}`
    )
  }
  const model = provider.models.find((candidate) => candidate.id === selected.model_id)
  if (model === undefined) {
    throw new Error(
      `model ${selected.provider}/${selected.model_id} is absent from model catalog revision ${JSON.stringify(snapshot.revision)}`
    )
  }
  return model
}

// selectedModelFrom combines one private provider connection with public metadata from the
// process catalog snapshot.
export const selectedModelFrom = (
  config: ModelConfig,
  credentials: ModelCredentials,
  catalog: ModelCatalogState,
  reference?: ModelCoordinate
): SelectedModel => {
  const selected = reference ?? config.default
  if (selected === undefined) throw new Error("the built-in actor has no model coordinate; run `tdg setup`")
  const provider = connectionFrom(config, credentials, selected)
  if (catalog.snapshot === undefined) {
    throw new Error(`model catalog metadata is unavailable for ${selected.provider}/${selected.model_id}; check the server startup logs`)
  }
  const catalogModel = catalogModelFrom(catalog.snapshot, selected)
  const metadata = catalogModel.metadata
  if (metadata.contextWindowTokens === undefined) {
    throw new Error(`model catalog has no context window for ${selected.provider}/${selected.model_id}`)
  }
  return {
    ...selected,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    protocol: provider.protocol,
    ...(provider.region === undefined ? {} : { region: provider.region }),
    contextWindowTokens: metadata.contextWindowTokens,
    ...(metadata.maxOutputTokens === undefined ? {} : { maxOutputTokens: metadata.maxOutputTokens }),
    ...(metadata.pricing === undefined ? {} : { pricing: metadata.pricing }),
    catalogRevision: catalog.snapshot.revision
  }
}

// modelIsConfigured says whether a turn can reach a model at all. The command line reads it to say
// so once on boot rather than letting every turn be the first news (apps/cli/src/commands.ts).
export const modelIsConfigured = (config: ServerConfigValue): boolean =>
  (() => {
    try {
      if (config.model.default === undefined) return false
      connectionFrom(config.model, config.modelCredentials, config.model.default)
      return true
    } catch {
      return false
    }
  })()

const layerInferFrom = (config: ServerConfigValue, catalog: ModelCatalogState): Layer.Layer<Infer> => {
  if (Object.keys(config.model.providers).length === 0) {
    const failed: Action = { kind: "fail", error: MISSING_MODEL, failure: { cause: "inference_error", attempts: 1 } }
    return Layer.succeed(Infer)({
      resolve: () => { throw new Error(MISSING_MODEL) },
      react: () => Effect.succeed(failed)
    })
  }
  return Layer.succeed(Infer, {
    resolve: (coordinate) => {
      const selected = selectedModelFrom(config.model, config.modelCredentials, catalog, coordinate)
      return {
        model: coordinate,
        contextWindowTokens: selected.contextWindowTokens,
        ...(selected.maxOutputTokens === undefined ? {} : { maxOutputTokens: selected.maxOutputTokens }),
        catalogRevision: selected.catalogRevision
      }
    },
    react: (request, key) => Effect.suspend(() => {
      let selected: SelectedModel
      try {
        selected = selectedModelFrom(config.model, config.modelCredentials, catalog, request.model)
      } catch (error) {
        return Effect.succeed<Action>({
          kind: "fail",
          error: error instanceof Error ? error.message : String(error),
          failure: { cause: "inference_error", attempts: 0 }
        })
      }
      const binding = infer({
        baseUrl: selected.baseUrl,
        apiKey: selected.apiKey,
        model: selected.model_id,
        protocol: selected.protocol,
        provider: selected.provider,
        ...(selected.region === undefined ? {} : { region: selected.region }),
        contextWindowTokens: selected.contextWindowTokens,
        ...(selected.maxOutputTokens === undefined ? {} : { maxOutputTokens: selected.maxOutputTokens }),
        ...(selected.pricing === undefined ? {} : { pricing: selected.pricing })
      })
      return Effect.flatMap(Infer, (model) => model.react(request, key)).pipe(Effect.provide(binding))
    })
  })
}

// The lane environment: everything the assembly needs that the bun host does not bind. The model
// binding is one of them, and so are the platform services the files and fetch packages reach
// through, bound here to their bun implementations. The union comes off the assembly's own type
// (actor.ts, ServerR), so a package added to the assembly is a compile error here until it is bound.
const layerLane = (config: ServerConfigValue, catalog: ModelCatalogState, options: ThreadsOptions) =>
  Layer.mergeAll(
    options.infer ?? layerInferFrom(config, catalog),
    BunFileSystem.layer,
    BunPath.layer,
    FetchHttpClient.layer
  )

export interface ThreadsOptions {
  // The model seam. Absent, the binding is derived from ServerConfig; present, it replaces that
  // derivation whole, which is how a test runs a scripted mind with no credentials
  // (host.test.ts). It is the one seam because Infer is the one place a turn leaves the process.
  readonly infer?: Layer.Layer<Infer>
  // providers interpret replies whose durable inbound link targets an external provider instance.
  readonly providers?: ReadonlyArray<Provider>
  // actorRefresh watches the actor root and reconciles its artifacts after the stated debounce.
  // Absent keeps a hosted server's registry fixed except for PUT /v1/actors; tdg dev supplies it.
  readonly actorRefresh?: {
    readonly debounceMillis: number
    readonly onError?: ((error: Error) => void) | undefined
  } | undefined
}

interface ActorRuntime {
  readonly summary: ActorSummary
  readonly threads: ActorThreads
  readonly commit: (delivery: Envelope) => Effect.Effect<void>
  readonly schedule: Effect.Effect<void>
  readonly resting: () => Promise<boolean>
  readonly dirty: () => number
  readonly close: () => Promise<void>
}

const digestOf = (module: string): string =>
  `sha256:${createHash("sha256").update(module).digest("hex")}`

const definitionOf = async (modulePath: string, expected: ActorArtifactManifest): Promise<ActorDefinition<ServerR>> => {
  const loaded: unknown = await import(`${pathToFileURL(modulePath).href}?digest=${encodeURIComponent(expected.digest)}`)
  const definition = (loaded as { readonly default?: unknown }).default
  if (typeof definition !== "object" || definition === null) {
    throw new Error("actor artifact must default export defineActor({ name, methods, actor })")
  }
  const candidate = definition as Partial<ActorDefinition<ServerR>>
  if (candidate.name !== expected.name || !ACTOR_NAME_PATTERN.test(expected.name)) {
    throw new Error(`actor artifact name does not match ${JSON.stringify(expected.name)}`)
  }
  if (
    typeof candidate.actor !== "object" ||
    candidate.actor === null ||
    !Array.isArray(candidate.actor.reactors) ||
    typeof candidate.actor.keyOf !== "function"
  ) {
    throw new Error("actor artifact does not contain an Actor")
  }
  if (typeof candidate.methods !== "object" || candidate.methods === null || Array.isArray(candidate.methods)) {
    throw new Error("actor artifact does not declare its methods")
  }
  actorMethodsOf(candidate.methods as ActorMethods)
  return candidate as ActorDefinition<ServerR>
}

const runtimeOf = async (
  summary: ActorSummary,
  definition: ActorDefinition<ServerR>,
  log: string,
  lane: ReturnType<typeof layerLane>,
  providers: ReadonlyArray<Provider>,
  maxConcurrentLanes: number
): Promise<ActorRuntime> => {
  const actor = definition.actor
  const host: BunHost = await createBunHost<ServerR>({
    log,
    principal: summary.name,
    actorFor: (candidate) => (idOf(candidate) === undefined ? undefined : actor),
    layersFor: () => lane,
    providers,
    driver: { maxConcurrentLanes },
    keyOf: (event) => actor.keyOf?.(event)
  })
  let driving: Promise<void> | undefined
  let follow = false
  let failure: unknown = undefined
  const pump = async (): Promise<void> => {
    try {
      do {
        follow = false
        await host.drive()
      } while (follow)
    } catch (error) {
      failure = error
    } finally {
      driving = undefined
      follow = false
    }
  }
  const request = (): Promise<void> => {
    if (driving !== undefined) {
      follow = true
      return driving
    }
    driving = pump()
    return driving
  }
  const settled = Effect.suspend(() =>
    Effect.promise(() => driving ?? Promise.resolve()).pipe(
      Effect.flatMap(() => {
        if (failure === undefined) return Effect.void
        const held = failure
        failure = undefined
        return Effect.die(held)
      })
    )
  )
  await host.recover()
  const read = (id: string) => Effect.promise(() => host.read(laneOf(id)))
  const commitRoot = (id: string, event: Event) =>
    Effect.gen(function*() {
      const at = yield* Clock.currentTimeMillis
      const stamped = event.at === undefined ? { ...event, at } : event
      yield* Effect.promise(() => host.commitRoot(host.self(laneOf(id)), stamped))
    })
  const commit = (delivery: Envelope) =>
    Effect.gen(function*() {
      const at = yield* Clock.currentTimeMillis
      const event = delivery.event
      const stamped = event.at === undefined ? { ...event, at } : event
      const placed: Envelope = {
        ...delivery,
        link: {
          source: delivery.link.source,
          target: { actor: summary.name, thread: laneOf(delivery.link.target.thread) }
        },
        event: stamped
      }
      yield* Effect.promise(() => host.commit(placed))
    })
  const threads: ActorThreads = {
    methods: definition.methods,
    append: (id, event) =>
      Effect.gen(function*() {
        yield* commitRoot(id, event)
        request()
      }),
    events: read,
    list: Effect.gen(function*() {
      const lanes = yield* Effect.promise(() => host.lanes())
      const ids = lanes.flatMap((candidate) => {
        const id = idOf(candidate)
        return id === undefined ? [] : [id]
      })
      return yield* Effect.forEach(ids, (id) => Effect.map(read(id), (events) => ({ id, events })))
    }),
    settled
  }
  return {
    summary,
    threads,
    commit,
    schedule: Effect.sync(() => {
      request()
    }),
    resting: () => host.resting(),
    dirty: host.work,
    close: async () => {
      await Effect.runPromise(settled)
      await host.close()
    }
  }
}

const manifestOf = async (directory: string): Promise<{ readonly manifest: ActorArtifactManifest; readonly module: string }> => {
  const raw = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Partial<ActorArtifactManifest>
  if (
    raw.schema !== ACTOR_ARTIFACT_VERSION ||
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
    const lane = layerLane(config, catalog, options)
    const runtimes = new Map<string, ActorRuntime>()
    const registry = yield* openBunActorRegistry<ActorSummary>({ file: config.db })
    const runRegistry = Effect.runPromiseWith(yield* Effect.context<never>())
    const builtIn = modelIsConfigured(config)
      ? builtInActor({
          provider: config.model.default!.provider,
          default_model: config.model.default!.model_id,
          contextWindowTokens: (model) => selectedModelFrom(config.model, config.modelCredentials, catalog, model).contextWindowTokens
        })
      : builtInActor()
    const root = resolve(config.actors)
    let mutations: Promise<void> = Promise.resolve()
    const exclusive = <A>(operation: () => Promise<A>): Promise<A> => {
      const result = mutations.then(operation, operation)
      mutations = result.then(() => undefined, () => undefined)
      return result
    }
    const open = async (summary: ActorSummary, definition: ActorDefinition<ServerR>, log: string): Promise<ActorRuntime> => {
      const runtime = await runtimeOf(
        summary,
        definition,
        log,
        lane,
        options.providers ?? [],
        config.maxConcurrentLanes
      )
      runtimes.set(summary.name, runtime)
      await runRegistry(registry.put(summary))
      return runtime
    }
    const load = async (directory: string): Promise<{ readonly summary: ActorSummary; readonly definition: ActorDefinition<ServerR> }> => {
      const artifact = await manifestOf(directory)
      if (artifact.manifest.name === RESERVED_ACTOR) throw new Error(`${RESERVED_ACTOR} is reserved for the built-in actor`)
      const definition = await definitionOf(join(directory, artifact.manifest.module), artifact.manifest)
      return {
        summary: { name: definition.name, builtIn: false, digest: artifact.manifest.digest },
        definition
      }
    }
    const replace = async (summary: ActorSummary, definition: ActorDefinition<ServerR>): Promise<void> => {
      const current = runtimes.get(summary.name)
      if (current?.summary.digest === summary.digest) return
      if (current !== undefined) {
        await current.close()
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
        await runtime.close()
        runtimes.delete(name)
        await runRegistry(registry.remove(name))
      }
      for (const registration of await runRegistry(registry.list)) {
        if (!runtimes.has(registration.name)) await runRegistry(registry.remove(registration.name))
      }
    }
    let watcher: FSWatcher | undefined
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    yield* Effect.acquireRelease(
      Effect.promise(async () => {
        await open({ name: RESERVED_ACTOR, builtIn: true }, builtIn, config.db)
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
        return runtimes
      }),
      (opened) => Effect.promise(async () => {
        watcher?.close()
        if (refreshTimer !== undefined) clearTimeout(refreshTimer)
        await mutations
        await Promise.all([...opened.values()].map((runtime) => runtime.close()))
      })
    )

    const selected = (name: string): Effect.Effect<ActorThreads | undefined> =>
      registry.resolve(name).pipe(Effect.map((registration) => registration === undefined ? undefined : runtimes.get(name)?.threads))
    const primary = runtimes.get(RESERVED_ACTOR)!.threads
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
            await current.close()
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
      ...primary,
      actors: registry.list,
      actor: selected,
      push,
      settled: Effect.forEach(runtimes.values(), (runtime) => runtime.threads.settled, { discard: true })
    }
    const directory: Directory<{ readonly actor: string }, {
      readonly commit: ActorRuntime["commit"]
      readonly schedule: ActorRuntime["schedule"]
    }> = {
      resolve: (id) => registry.resolve(id.actor).pipe(Effect.map((registration) => {
        const runtime = registration === undefined ? undefined : runtimes.get(registration.name)
        return runtime === undefined ? undefined : { commit: runtime.commit, schedule: runtime.schedule }
      }))
    }
    const ingress = ingressFrom(directory)
    const gauge: Context.Service.Shape<typeof DriverGauge> = {
      resting: Effect.promise(async () => (await Promise.all([...runtimes.values()].map((runtime) => runtime.resting()))).every(Boolean)),
      dirty: Effect.sync(() => [...runtimes.values()].reduce((total, runtime) => total + runtime.dirty(), 0))
    }
    return Context.make(Threads, service).pipe(
      Context.add(Ingress, ingress),
      Context.add(DriverGauge, gauge)
    )
  })

// layerThreads is the host, the assembly, and the driver: the Threads the routes consume and the
// DriverGauge /healthz reads, built once and closed with the scope.
export const layerThreads = (options: ThreadsOptions = {}): Layer.Layer<Threads | Ingress | DriverGauge, never, ServerConfig | ModelCatalogStore> =>
  Layer.effectContext(make(options))
