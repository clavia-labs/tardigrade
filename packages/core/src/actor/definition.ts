import { eventCatalog } from "./event"
import type { ActorMethods, ActorMethod } from "./method"
import { RuntimeError } from "../runtime/effects"
import { Context, Effect, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { atom, type Atom } from "../atoms/atom"
import type { EventValue } from "../atoms/effect"
import type { ActorSetup } from "../runtime/contracts"
import { createStore } from "../atoms/store"
import { EventLog } from "../services/event-log"
import { createEventSource } from "../runtime/event-source"

type MethodEvents<Methods> = { readonly [Key in keyof Methods]: Methods[Key] extends ActorMethod<infer Event> ? Event : never }[keyof Methods]
type ProjectionEvents<Value> = Value extends { readonly events: Readonly<Record<string, EventValue<infer Event>>> } ? Extract<Event, object> : never
type Resolved<Value> = Value extends AsyncResult.AsyncResult<infer Output, unknown> ? Output : Value

// resolveOutput unwraps synchronously evaluated projections; suspended projections cannot participate in synchronous replay.
function resolveOutput<Value>(value: Value): Resolved<Value> {
  if (AsyncResult.isAsyncResult(value)) {
    if (value.waiting || AsyncResult.isInitial(value)) throw new RuntimeError("Actor projections must resolve synchronously; return asynchronous work as an effect value")
    return AsyncResult.getOrThrow(value) as Resolved<Value>
  }
  return value as Resolved<Value>
}

export interface ActorDefinition<Event extends object, State, Services, Contracts extends ActorMethods<Event> = ActorMethods<Event>> {
  readonly actorName: string
  readonly setup: Effect.Effect<ActorSetup<Event, Readonly<Record<string, Atom<State>>>, Contracts> & { readonly root: Atom<State> }, Error, Services>
}

// defineActor assembles a reactive graph, event contract, and typed methods for instantiation by a host.
export function defineActor<Value, const Name extends string, Services, const Contracts extends ActorMethods<object> = {}, Event extends object = never>(name: Name, factory: Effect.Effect<{
  readonly atom: Atom<Value>
  readonly schema?: Schema.Schema<Event>
  readonly methods?: Contracts
}, Error, Services>) {
  if (!name || name.includes("/")) throw new RuntimeError("Actor name must be nonempty and contain no slash")
  type DomainEvents = Event | MethodEvents<Contracts> | ProjectionEvents<Resolved<Value>>
  type Output = Resolved<Value>
  type Atoms = { readonly [Key in Name]: Atom<Output> }
  const setup = factory.pipe(Effect.map(definition => {
    for (const [name, method] of Object.entries(definition.methods ?? {})) {
      if (!name) throw new RuntimeError("Actor method name must be nonempty")
      if (!Schema.isSchema(method.inputSchema) || !Schema.isSchema(method.outputSchema) || typeof method.onReceive !== "function" || typeof method.result !== "function" || (method.onCancel !== undefined && typeof method.onCancel !== "function")) throw new RuntimeError(`Invalid actor method contract: ${name}`)
    }
    const root = atom(get => resolveOutput(get(definition.atom)))
    const catalog = eventCatalog<DomainEvents>()
    for (const method of Object.values(definition.methods ?? {})) for (const schema of method.events) catalog.add(schema)
    const discovery = createStore(Context.make(EventLog, { events: createEventSource().events }))
    try {
      // TODO: Discover subscriptions first read after a branch change; setup currently registers the graph observed from initial state.
      for (const schema of discovery.eventSchemas({ [name]: root })) catalog.add(schema)
    } finally { discovery.dispose() }
    return {
      root,
      schema: (definition.schema ?? catalog.schema) as Schema.Schema<DomainEvents>,
      contracts: definition.methods ?? {} as Contracts,
      effects: { [name]: root } as Atoms,
    }
  }))
  const graph = () => Effect.scoped(Effect.gen(function* () {
    const definition = yield* factory
    const root = atom(get => resolveOutput(get(definition.atom)))
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => createStore(Context.make(EventLog, {
        events: createEventSource().events,
      }))),
      store => Effect.try({ try: () => store.graph({ [name]: root }), catch: RuntimeError.from }),
      store => Effect.sync(() => store.dispose()),
    )
  }))
  return { actorName: name, setup, graph }
}
