import { Clock, Context, Data, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import { createHash } from "node:crypto"
import { watch, type FSWatcher } from "node:fs"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { ActorThreadRecord } from "@clavia/tardigrade-core/actor"
import type { ThreadEventRow } from "@clavia/tardigrade-core/log"
import type { Envelope } from "@clavia/tardigrade-core/communication/envelope"
import type { Directory } from "@clavia/tardigrade-core/communication/directory"
import { Ingress, ingressFrom } from "@clavia/tardigrade-host/communication/ingress"
import type { Provider } from "@clavia/tardigrade-host/communication/provider"
import {
  applyModelPolicy,
  ACTOR_ARTIFACT_VERSION,
  ACTOR_NAME_PATTERN,
  Infer,
  actorMethodsOf,
  intersectModelPolicies,
  modelAllowedBy,
  type ActorMethods,
  type ModelRef,
  type ModelPolicy,
  type InferenceObserver,
  type ActorArtifactManifest,
  type Actor
} from "tardie"
import type { Action } from "tardie/log/events"
import { createBunHost, type BunHost, type BunHostOptions } from "@clavia/tardigrade-bun/host"
import { openBunActorRegistry } from "@clavia/tardigrade-bun/registry"
import { infer } from "@clavia/tardigrade-model/model"
import { modelAdapters, type ModelAdapter, type ModelAdapterRegistry } from "@clavia/tardigrade-model/adapter"
import {
  RESERVED_ACTOR,
  type ActorArtifact,
  type ActorSummary,
  type ModelCatalog
} from "@clavia/tardigrade-client/contract"

import { builtInActor, type ServerR } from "./actor"
import { ServerConfig, type ModelConfig, type ModelCredentials, type ServerConfigValue } from "./config"
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

// The durable host, the assembly it runs, and the loop that drives it, behind one service. The
// routes speak thread ids; the thread a host knows lives here and nowhere else, so a route can never
// name a thread and the store can never see an id.

// THREAD_PREFIX is the id-to-thread map (apps-server-spec.md, "Resources"). A thread outside it belongs
// to something other than a thread and never appears in a listing. The prefix stays `ag.` while the
// API's noun is the thread, because the thread is where the agent assembly runs, and that assembly
// mints its own child threads under the same prefix (packages/agent/src/packages/agents.ts, `sibling`). Renaming
// it would rename addresses a spawn already wrote into a durable log.
export const THREAD_PREFIX = "ag."

export const threadOf = (id: string): string => `${THREAD_PREFIX}${id}`

// idOf is threadOf's inverse, undefined for a thread this server does not own.
export const idOf = (thread: string): string | undefined =>
  thread.startsWith(THREAD_PREFIX) ? thread.slice(THREAD_PREFIX.length) : undefined

// ActorPushRefused is why a pushed actor was not accepted, in the sentence the route prints. The
// artifact checks and the swap both raise it, so a caller reads one failure rather than telling a
// validation `Error` apart from a filesystem one by its message (api.ts, pushActor).
export class ActorPushRefused extends Data.TaggedError("ActorPushRefused")<{
  readonly message: string
  readonly cause: unknown
}> {}

export interface ActorThreads {
  readonly methods: ActorMethods
  readonly sqlite: string
  readonly append: (id: string, event: Event) => Effect.Effect<void>
  readonly appendUnlessKeyPresent: (id: string, event: Event, key: string) => Effect.Effect<boolean>
  readonly events: (id: string) => Effect.Effect<ReadonlyArray<Event>>
  readonly eventsPage: (id: string, mark: number, limit: number) => Effect.Effect<ReadonlyArray<ThreadEventRow>>
  readonly awaitHead: (id: string, mark: number) => Effect.Effect<number>
  readonly actorEventsPage: (mark: number, limit: number) => Effect.Effect<ReadonlyArray<ThreadEventRow>>
  readonly actorThreads: Effect.Effect<{
    readonly cursor: number
    readonly threads: ReadonlyArray<ActorThreadRecord>
  }>
  readonly actorThread: (thread: string) => Effect.Effect<ActorThreadRecord | undefined>
  readonly awaitActorHead: (mark: number) => Effect.Effect<number>
  readonly list: Effect.Effect<ReadonlyArray<{ readonly id: string; readonly events: ReadonlyArray<Event> }>>
  readonly settled: Effect.Effect<void>
}

// Threads exposes the mounted actor's method declarations beside its durable thread operations. Method meaning stays with the actor, while the service stores and returns its event log (packages/core/src/method/method.ts, ActorMethodDeclaration).
export class Threads extends Context.Service<
  Threads,
  {
    readonly methods: ActorThreads["methods"]
    readonly sqlite: ActorThreads["sqlite"]
    readonly actorName?: string
    // settled resolves once the drive in flight, and the follow-up it coalesced, has finished. A
    // client never waits on it (a delivery answers 202 and the client polls the turn); a test and
    // a shutdown do (host.test.ts).
    readonly instances: Effect.Effect<ReadonlyArray<{ readonly id: string; readonly definition: string }>>
    readonly ensure: (id: string) => Effect.Effect<ActorThreads>
    readonly instance: (id: string) => Effect.Effect<ActorThreads | undefined>
    readonly append: (actor: string, thread: string, event: Event) => Effect.Effect<void>
    readonly appendUnlessKeyPresent: (
      actor: string,
      thread: string,
      event: Event,
      key: string
    ) => Effect.Effect<boolean>
    readonly events: (actor: string, thread: string) => Effect.Effect<ReadonlyArray<Event>>
    readonly list: (actor: string) => ActorThreads["list"]
    readonly settled: (actor: string) => Effect.Effect<void>
    readonly definitions?: Effect.Effect<ReadonlyArray<ActorSummary>>
    readonly definition?: (name: string) => Effect.Effect<ActorThreads | undefined>
    readonly pushDefinition?: (artifact: ActorArtifact) => Effect.Effect<ActorSummary, ActorPushRefused>
  }
>()("tardigrade/server/Threads") {}

// The model binding the configured references name. An absent reference is not an endpoint this
// server invents: every attempt fails with what is missing, so the process still boots, still
// answers /healthz, and says why a turn cannot run (config.ts, ModelConfig).
export const MISSING_MODEL = "no model provider is configured: run `tdg setup`"

interface SelectedModel {
  readonly model_id: string
  readonly provider: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly protocol: ModelConfig["providers"][string]["protocol"]
  readonly region?: string
  readonly contextWindowTokens: number
  readonly maxOutputTokens?: number
  readonly pricing?: import("tardie/inference/usage").ModelPricing
  readonly catalogRevision: string
}

interface ProviderConnection {
  readonly baseUrl: string
  readonly apiKey: string
  readonly protocol: ModelConfig["providers"][string]["protocol"]
  readonly region?: string
}

const connectionFrom = (
  config: ModelConfig,
  credentials: ModelCredentials,
  selected: ModelRef
): ProviderConnection => {
  const provider = config.providers[selected.provider]
  if (provider === undefined) {
    const available = Object.keys(config.providers).sort()
    throw new Error(
      `provider ${JSON.stringify(selected.provider)} is not configured for model ${JSON.stringify(selected.model_id)}; ` +
      `run \`tdg setup\`${available.length === 0 ? "" : `; configured providers: ${available.join(", ")}`}`
    )
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
  selected: ModelRef
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
  reference?: ModelRef
): SelectedModel => {
  const selected = reference ?? config.default
  if (selected === undefined) throw new Error("the built-in actor has no model reference; run `tdg setup`")
  if (!modelAllowedBy(config, selected)) {
    throw new Error(`model ${selected.provider}/${selected.model_id} is excluded by the host model policy`)
  }
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
      if (!modelAllowedBy(config.model, config.model.default)) return false
      connectionFrom(config.model, config.modelCredentials, config.model.default)
      return true
    } catch {
      return false
    }
  })()

const layerInferFrom = (
  config: ServerConfigValue,
  catalog: ModelCatalogState,
  adapters: ModelAdapterRegistry,
  observer?: InferenceObserver
): Layer.Layer<Infer> => {
  if (Object.keys(config.model.providers).length === 0) {
    const failed: Action = { kind: "fail", error: MISSING_MODEL, failure: { cause: "inference_error", attempts: 1 } }
    return Layer.succeed(Infer)({
      resolve: () => { throw new Error(MISSING_MODEL) },
      react: () => Effect.succeed(failed)
    })
  }
  const availableModels = (): ModelPolicy => {
    const snapshot = catalog.snapshot
    if (snapshot === undefined) return { allow: [] }
    const availability = providerAvailabilitiesOf(config.model, config.modelCredentials)
    const configured: ModelPolicy = {
      allow: snapshot.providers.flatMap((provider) =>
        availability[provider.id]?.status === "available" && provider.models.length > 0
          ? [{ provider: provider.id, model_ids: provider.models.map((model) => model.id) }]
          : []
      )
    }
    const authority = intersectModelPolicies([config.model, configured])
    return { ...authority, ...(config.model.default === undefined ? {} : { default: config.model.default }) }
  }
  return Layer.succeed(Infer, {
    resolve: (reference) => {
      const selected = selectedModelFrom(config.model, config.modelCredentials, catalog, reference)
      return {
        model: { provider: selected.provider, model_id: selected.model_id },
        models: availableModels(),
        contextWindowTokens: selected.contextWindowTokens,
        ...(selected.maxOutputTokens === undefined ? {} : { maxOutputTokens: selected.maxOutputTokens }),
        catalogRevision: selected.catalogRevision
      }
    },
    react: (request, key, signal) => Effect.suspend(() => {
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
      }, adapters, observer === undefined ? {} : { observer })
      return Effect.flatMap(Infer, (model) => model.react(request, key, signal)).pipe(Effect.provide(binding))
    })
  })
}

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
    options.infer ?? layerInferFrom(config, catalog, adapters, options.inferenceObserver),
    BunFileSystem.layer,
    BunPath.layer,
    FetchHttpClient.layer
  )

export interface ThreadsOptions {
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
    !Array.isArray(candidate.projections) ||
    typeof candidate.keyOf !== "function" ||
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

const runtimeOf = async <R>(
  summary: ActorSummary,
  actorInstance: string,
  definition: Actor<R>,
  database: string,
  thread: ReturnType<typeof layerThread>,
  providers: ReadonlyArray<Provider>,
  maxConcurrentThreads: number,
  layersFor?: ActorThreadLayersFor<R>
): Promise<ActorRuntime> => {
  const actor = definition
  const environmentFor = ((candidate: string) => {
    const application = layersFor?.({ actorInstance, thread: candidate })
    return application === undefined ? thread : Layer.mergeAll(thread, application)
  }) as NonNullable<BunHostOptions<R>["layersFor"]>
  const host: BunHost = await createBunHost<R>({
    database,
    actorName: summary.name,
    actorInstance,
    actorFor: (candidate) => (idOf(candidate) === undefined ? undefined : actor),
    layersFor: environmentFor,
    providers,
    driver: { maxConcurrentThreads },
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
  const read = (id: string) => Effect.promise(() => host.read(threadOf(id)))
  const readPage = (id: string, mark: number, limit: number) =>
    Effect.promise(() => host.readPage(threadOf(id), mark, limit))
  const awaitHead = (id: string, mark: number) =>
    Effect.promise((signal) => host.awaitHead(threadOf(id), mark, signal))
  const awaitActorHead = (mark: number) => Effect.promise((signal) => host.awaitActorHead(mark, signal))
  const commitRoot = (id: string, event: Event) =>
    Effect.gen(function*() {
      const at = yield* Clock.currentTimeMillis
      const stamped = event.at === undefined ? { ...event, at } : event
      yield* Effect.promise(() => host.commitRoot(host.self(threadOf(id)), stamped))
    })
  const commitRootUnlessKeyPresent = (id: string, event: Event, key: string) =>
    Effect.gen(function*() {
      const at = yield* Clock.currentTimeMillis
      const stamped = event.at === undefined ? { ...event, at } : event
      return yield* Effect.promise(() =>
        host.commitRootUnlessKeyPresent(host.self(threadOf(id)), stamped, key)
      )
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
          target: { actor: summary.name, instance: actorInstance, thread: threadOf(delivery.link.target.thread) }
        },
        event: stamped
      }
      yield* Effect.promise(() => host.commit(placed))
    })
  const threads: ActorThreads = {
    methods: definition.methods,
    sqlite: database === ":memory:" ? database : resolve(database),
    append: (id, event) =>
      Effect.gen(function*() {
        yield* commitRoot(id, event)
        request()
      }),
    appendUnlessKeyPresent: (id, event, key) =>
      Effect.gen(function*() {
        const appended = yield* commitRootUnlessKeyPresent(id, event, key)
        if (appended) request()
        return appended
      }),
    events: read,
    eventsPage: readPage,
    awaitHead,
    actorEventsPage: (mark, limit) => Effect.promise(() => host.readActorPage(mark, limit)),
    actorThreads: Effect.promise(() => host.actorThreads()),
    actorThread: (thread) => Effect.promise(() => host.actorThread(thread)),
    awaitActorHead,
    list: Effect.gen(function*() {
      const threads = yield* Effect.promise(() => host.threads())
      const ids = threads.flatMap((candidate) => {
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

type ActorThreadsBaseOptions = Pick<ThreadsOptions, "infer" | "inferenceObserver" | "modelAdapters" | "providers">

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

// layerActorThreads mounts one deployed definition as the runtime.
export const layerActorThreads = <R>(
  definition: Actor<R>,
  ...[options = {} as ActorThreadsOptions<R>]: ActorThreadsArguments<R>
): Layer.Layer<Threads | Ingress | DriverGauge, never, ServerConfig | ModelCatalogStore> =>
  Layer.effectContext(Effect.gen(function*() {
    const config = yield* ServerConfig
    const catalog = yield* ModelCatalogStore
    const adapters = options.modelAdapters ?? (yield* Effect.promise(() => serverModelAdaptersFor(config)))
    for (const provider of Object.values(config.model.providers)) adapters.resolve(provider.protocol)
    const summary: ActorSummary = { name: definition.name, builtIn: false }
    const thread = layerThread(config, catalog, options, adapters)
    const runtimes = new Map<string, ActorRuntime>()
    const opening = new Map<string, Promise<ActorRuntime>>()
    const open = (id: string): Promise<ActorRuntime> => {
      const current = runtimes.get(id)
      if (current !== undefined) return Promise.resolve(current)
      const pending = opening.get(id)
      if (pending !== undefined) return pending
      const created = runtimeOf(
        summary,
        id,
        definition,
        actorDatabasePath(config.db, id),
        thread,
        options.providers ?? [],
        config.maxConcurrentThreads,
        options.layersFor
      ).then((runtime) => {
        runtimes.set(id, runtime)
        opening.delete(id)
        return runtime
      }, (cause) => {
        opening.delete(id)
        throw cause
      })
      opening.set(id, created)
      return created
    }
    yield* Effect.acquireRelease(
      Effect.promise(async () => {
        if (config.db !== ":memory:") {
          const directory = `${config.db}.actors`
          const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return []
            throw error
          })
          for (const file of files) {
            const id = actorIdFromDatabase(file)
            if (id !== undefined) await open(id)
          }
        }
      }),
      () => Effect.promise(async () => {
        await Promise.all(opening.values())
        await Promise.all([...runtimes.values()].map((runtime) => runtime.close()))
      })
    )
    const service: Context.Service.Shape<typeof Threads> = {
      methods: definition.methods,
      sqlite: config.db === ":memory:" ? config.db : resolve(config.db),
      actorName: definition.name,
      instances: Effect.sync(() => [...runtimes.keys()].sort().map((id) => ({ id, definition: definition.name }))),
      ensure: (id) => Effect.promise(() => open(id)).pipe(Effect.map((runtime) => runtime.threads)),
      instance: (id) => Effect.succeed(runtimes.get(id)?.threads),
      append: (actor, thread, event) => Effect.flatMap(Effect.promise(() => open(actor)), (runtime) => runtime.threads.append(thread, event)),
      appendUnlessKeyPresent: (actor, thread, event, key) =>
        Effect.flatMap(
          Effect.promise(() => open(actor)),
          (runtime) => runtime.threads.appendUnlessKeyPresent(thread, event, key)
        ),
      events: (actor, thread) => runtimes.get(actor)?.threads.events(thread) ?? Effect.succeed([]),
      list: (actor) => runtimes.get(actor)?.threads.list ?? Effect.succeed([]),
      settled: (actor) => runtimes.get(actor)?.threads.settled ?? Effect.void
    }
    const directory: Directory<{ readonly actor: string; readonly instance: string }, {
      readonly commit: ActorRuntime["commit"]
      readonly schedule: ActorRuntime["schedule"]
    }> = {
      resolve: (id) => Effect.succeed(id.actor === definition.name
        ? (() => {
            const runtime = runtimes.get(id.instance)
            return runtime === undefined ? undefined : { commit: runtime.commit, schedule: runtime.schedule }
          })()
        : undefined)
    }
    return Context.make(Threads, service).pipe(
      Context.add(Ingress, ingressFrom(directory)),
      Context.add(DriverGauge, {
        resting: Effect.promise(async () => (await Promise.all([...runtimes.values()].map((runtime) => runtime.resting()))).every(Boolean)),
        dirty: Effect.sync(() => [...runtimes.values()].reduce((total, runtime) => total + runtime.dirty(), 0))
      })
    )
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
    const runtimes = new Map<string, ActorRuntime>()
    const instances = new Map<string, ActorRuntime>()
    const openingInstances = new Map<string, Promise<ActorRuntime>>()
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
    const open = async (summary: ActorSummary, definition: Actor<ServerR>, database: string): Promise<ActorRuntime> => {
      const runtime = await runtimeOf(
        summary,
        summary.name,
        definition,
        database,
        thread,
        options.providers ?? [],
        config.maxConcurrentThreads
      )
      runtimes.set(summary.name, runtime)
      await runRegistry(registry.put(summary))
      return runtime
    }
    const openInstance = (id: string): Promise<ActorRuntime> => {
      const current = instances.get(id)
      if (current !== undefined) return Promise.resolve(current)
      const pending = openingInstances.get(id)
      if (pending !== undefined) return pending
      const created = runtimeOf(
        builtInSummary,
        id,
        builtIn,
        actorDatabasePath(config.db, id),
        thread,
        options.providers ?? [],
        config.maxConcurrentThreads
      ).then((runtime) => {
        instances.set(id, runtime)
        openingInstances.delete(id)
        return runtime
      }, (cause) => {
        openingInstances.delete(id)
        throw cause
      })
      openingInstances.set(id, created)
      return created
    }
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
        if (registration.name !== RESERVED_ACTOR && !runtimes.has(registration.name)) {
          await runRegistry(registry.remove(registration.name))
        }
      }
    }
    let watcher: FSWatcher | undefined
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    yield* Effect.acquireRelease(
      Effect.promise(async () => {
        await runRegistry(registry.put(builtInSummary))
        await synchronize()
        if (config.db !== ":memory:") {
          const directory = `${config.db}.actors`
          const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return []
            throw error
          })
          for (const file of files) {
            const id = actorIdFromDatabase(file)
            if (id !== undefined) await openInstance(id)
          }
        }
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
        return { runtimes, instances }
      }),
      (opened) => Effect.promise(async () => {
        watcher?.close()
        if (refreshTimer !== undefined) clearTimeout(refreshTimer)
        await mutations
        await Promise.all(openingInstances.values())
        await Promise.all([...opened.runtimes.values(), ...opened.instances.values()].map((runtime) => runtime.close()))
      })
    )

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
      methods: builtIn.methods,
      sqlite: config.db === ":memory:" ? config.db : resolve(config.db),
      actorName: builtIn.name,
      instances: Effect.sync(() => [...instances.keys()].sort().map((id) => ({ id, definition: builtIn.name }))),
      ensure: (id) => Effect.promise(() => openInstance(id)).pipe(Effect.map((runtime) => runtime.threads)),
      instance: (id) => Effect.succeed(instances.get(id)?.threads),
      append: (actor, thread, event) => Effect.flatMap(Effect.promise(() => openInstance(actor)), (runtime) => runtime.threads.append(thread, event)),
      appendUnlessKeyPresent: (actor, thread, event, key) =>
        Effect.flatMap(
          Effect.promise(() => openInstance(actor)),
          (runtime) => runtime.threads.appendUnlessKeyPresent(thread, event, key)
        ),
      events: (actor, thread) => instances.get(actor)?.threads.events(thread) ?? Effect.succeed([]),
      list: (actor) => instances.get(actor)?.threads.list ?? Effect.succeed([]),
      settled: (actor) => instances.get(actor)?.threads.settled ?? Effect.void,
      definitions: registry.list,
      definition: selected,
      pushDefinition: push
    }
    const directory: Directory<{ readonly actor: string; readonly instance: string }, {
      readonly commit: ActorRuntime["commit"]
      readonly schedule: ActorRuntime["schedule"]
    }> = {
      resolve: (id) => registry.resolve(id.actor).pipe(Effect.flatMap((registration) => {
        if (registration === undefined) return Effect.as(Effect.void, undefined as undefined)
        const runtime = registration.name === RESERVED_ACTOR
          ? Effect.promise(() => openInstance(id.instance))
          : Effect.succeed(runtimes.get(registration.name))
        return Effect.map(runtime, (resolved) => resolved === undefined
          ? undefined
          : { commit: resolved.commit, schedule: resolved.schedule })
      }))
    }
    const ingress = ingressFrom(directory)
    const gauge: Context.Service.Shape<typeof DriverGauge> = {
      resting: Effect.promise(async () => (await Promise.all(
        [...runtimes.values(), ...instances.values()].map((runtime) => runtime.resting())
      )).every(Boolean)),
      dirty: Effect.sync(() => [...runtimes.values(), ...instances.values()].reduce((total, runtime) => total + runtime.dirty(), 0))
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
