import { Context, Effect, Layer, Schema } from "effect"
import { Rpc } from "effect/rpc"
import { agent, agentMethods } from "@clavia/tardigrade-agent"
import { act, atom, defineActor, effectAtom } from "@clavia/tardigrade-core"
import { Library } from "@clavia/tardigrade-libraries"
import { host as bunHost } from "../../src/bun"
import { host as cloudflareHost } from "../../src/cloudflare"
import { contentModelServices } from "../fixtures/agent"

const reader = Library.make("reader", Rpc.make("read", {
  payload: Schema.Struct({ key: Schema.String }), success: Schema.String,
}))

export function inferredMethodsRetainLibraryRequirements() {
  const methods = { inspectNotes: agentMethods.message }
  const assistant = agent({
    name: "inferred-methods",
    system: "Read notes.",
    methods,
    tools: [reader],
  })
  const libraries: readonly [typeof reader] = assistant.libraries
  const contract = Effect.map(assistant.inspect, inspection => {
    const input: typeof methods.inspectNotes.inputSchema = inspection.methods.inspectNotes.inputSchema
    return input
  })
  const model = contentModelServices(() => {})
  const layer = Layer.merge(model, Layer.succeed(reader, { read: ({ key }) => Effect.succeed(key) }))
  const runtime = bunHost(assistant, { storage: ".unused", layer })
  const worker = cloudflareHost(assistant, { layer })

  // @ts-expect-error bunHost requires the selected Reader implementation.
  const missingBun = bunHost(assistant, { storage: ".unused", layer: model })

  // @ts-expect-error cloudflareHost requires the selected Reader implementation.
  const missingCloudflare = cloudflareHost(assistant, { layer: model })

  return { libraries, contract, runtime, worker, missingBun, missingCloudflare }
}

export function agentsRequireBindableLibraries() {
  // @ts-expect-error Agent construction requires bindings for its automatically installed libraries.
  const unbound = agent({ name: "unbound", system: "Read notes.", tools: [{ name: "reader" }] })
  return unbound
}

const other = Library.make("other", Rpc.make("read", {
  payload: Schema.Struct({ key: Schema.String }), success: Schema.String,
}))

class Storage extends Context.Service<Storage, {
  readonly get: (key: string) => Effect.Effect<string>
}>()("library-api/Storage") {}

export function generatedServicesRetainIdentityAndDependencies() {
  const assistant = agent({ name: "reader", system: "Read notes.", tools: [reader] })
  const model = contentModelServices(() => {})
  const readerLayer = Layer.effect(reader, Effect.map(Storage, storage => ({
    read: ({ key }) => storage.get(key),
  })))
  const storageLayer = Layer.succeed(Storage, { get: key => Effect.succeed(key) })
  const runtime = bunHost(assistant, { storage: ".unused", layer: Layer.merge(model, readerLayer.pipe(Layer.provide(storageLayer))) })
  const direct = Effect.gen(function* () {
    const service = yield* reader
    return yield* service.read({ key: "note" })
  }).pipe(Effect.scoped, Effect.provide(readerLayer.pipe(Layer.provide(storageLayer))))

  // @ts-expect-error The generated reader service retains the adapter's Storage requirement.
  // @effect-diagnostics-next-line missingLayerContext:off
  const unresolved = bunHost(assistant, { storage: ".unused", layer: Layer.merge(model, readerLayer) })

  // @ts-expect-error A same-shaped library with another name cannot satisfy reader.
  const wrong = cloudflareHost(assistant, { layer: Layer.merge(model, Layer.succeed(other, { read: ({ key }) => Effect.succeed(key) })) })

  // @ts-expect-error The method result is derived from the RPC success schema.
  const invalid = Layer.succeed(reader, { read: () => Effect.succeed(123) })

  // @ts-expect-error Per-call dependencies must be captured when constructing the implementation.
  // @effect-diagnostics-next-line missingEffectContext:off
  const hidden = Layer.succeed(reader, { read: ({ key }) => Effect.flatMap(Storage, storage => storage.get(key)) })

  return { runtime, direct, unresolved, wrong, invalid, hidden }
}

export function ordinaryActorsDeclareSetupAndExecutionRequirements() {
  const Notify = act({ name: "notify", input: Schema.String, success: Schema.Null, failure: Schema.String })
  const counter = defineActor("counter", Effect.map(Storage, storage => ({
    atom: effectAtom(() => ({ view: storage, events: {}, acts: { notify: Notify.request({ input: "ready" }) } })),
  })))
  const layer = Layer.merge(
    Layer.succeed(Storage, { get: key => Effect.succeed(key) }),
    Notify.layer(() => Effect.succeed(null)),
  )
  const runtime = bunHost(counter, { storage: ".unused", layer })
  const worker = cloudflareHost(counter, { layer })
  const empty = defineActor("empty", Effect.succeed({ atom: atom(0) }))
  const emptyRuntime = bunHost(empty, { storage: ".unused", layer: Layer.empty })
  const emptyWorker = cloudflareHost(empty, { layer: Layer.empty })

  // @ts-expect-error Ordinary actors require their setup services.
  const missingSetup = bunHost(counter, { storage: ".unused", layer: Notify.layer(() => Effect.succeed(null)) })

  // @ts-expect-error Ordinary actors require their execution services.
  const missingExecution = cloudflareHost(counter, { layer: Layer.succeed(Storage, { get: key => Effect.succeed(key) }) })

  const adapted = { ...counter, layer: Notify.layer(() => Effect.succeed(null)) }
  const adaptedWorker = cloudflareHost(adapted, { layer: Layer.succeed(Storage, { get: key => Effect.succeed(key) }) })

  // @ts-expect-error A definition-owned layer does not supply the actor's remaining setup dependency.
  const missingAdapted = bunHost(adapted, { storage: ".unused", layer: Layer.empty })

  return { runtime, worker, emptyRuntime, emptyWorker, adaptedWorker, missingAdapted, missingSetup, missingExecution }
}
