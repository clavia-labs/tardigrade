import { Context, Effect, Layer } from "effect"
import { agent } from "@clavia/tardigrade-agent/agent"
import type { Event } from "@clavia/tardigrade-agent/contracts/events"
import { host, Bindings, DurableStorage, HostThread, ThreadRuntime } from "../../../src/cloudflare"
import { Notebook } from "../library-service"
import { contentModelServices } from "../agent"

export interface HostLayerEnv { readonly LAYER_BINDING: string }
const definition = agent({ name: "layer-agent", system: "Record a research finding.", tools: [Notebook] })
const setupIsolation: boolean[] = []
export const layerSetupIsolation = () => setupIsolation
const assistant = { ...definition, setup: definition.setup.pipe(Effect.tap(() => Effect.map(Effect.context<never>(), context => {
  setupIsolation.push(Context.getOrUndefined(context, DurableStorage) === undefined
    && Context.getOrUndefined(context, HostThread) === undefined
    && Context.getOrUndefined(context, Bindings<HostLayerEnv>()) === undefined
    && Context.getOrUndefined(context, ThreadRuntime<Event>()) === undefined)
}))) }
const lifetimes: Array<{ id: string; instance: string; thread: string; ready: boolean; closed: boolean }> = []
export const layerLifetimes = () => lifetimes
let modelCalls = 0
export const layerModelCalls = () => modelCalls

const notebook = Layer.effect(Notebook, Effect.gen(function* () {
  const env = yield* Bindings<HostLayerEnv>()
  const storage = yield* DurableStorage
  const thread = yield* HostThread
  const runtime = yield* ThreadRuntime<Event>()
  const lifetime = yield* Effect.acquireRelease(Effect.sync(() => {
    const value = { id: String(lifetimes.length), instance: thread.instance, thread: thread.thread, ready: false, closed: false }
    lifetimes.push(value)
    return value
  }), value => Effect.sync(() => { value.closed = true }))
  yield* runtime.onReady(Effect.sync(() => { lifetime.ready = true }))
  return Notebook.of({
    read: ({ path }) => Effect.tryPromise({ try: () => storage.get<string>(`note:${path}`), catch: String }).pipe(Effect.map(value => value ?? "")),
    write: ({ path, text }) => Effect.tryPromise({ try: () => storage.put(`note:${path}`, `${env.LAYER_BINDING}:${thread.thread}:${text}`), catch: String }),
  })
}))

const models = contentModelServices(() => { modelCalls++ }, {
  toolCalls: [{ id: "write", name: "write_note", params: { path: "research.md", text: "A durable finding." } }],
})

const worker = host(assistant, { layer: Layer.mergeAll(models, notebook) })
interface FixtureEnv extends HostLayerEnv {
  readonly HOST_LAYER_ACTORS: DurableObjectNamespace<InstanceType<typeof worker.ActorObject>>
  readonly HOST_LAYER_THREADS: DurableObjectNamespace<InstanceType<typeof worker.ThreadObject>>
}
export class HostLayerActorDO extends worker.ActorObject {
  constructor(ctx: ConstructorParameters<typeof worker.ActorObject>[0], env: FixtureEnv) {
    super(ctx, { ...env, ACTORS: env.HOST_LAYER_ACTORS, THREADS: env.HOST_LAYER_THREADS })
  }
}
export class HostLayerThreadDO extends worker.ThreadObject {
  constructor(ctx: ConstructorParameters<typeof worker.ThreadObject>[0], env: FixtureEnv) {
    super(ctx, { ...env, ACTORS: env.HOST_LAYER_ACTORS, THREADS: env.HOST_LAYER_THREADS })
  }
}
export default worker
