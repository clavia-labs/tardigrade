import { RuntimeError } from "./errors"
import { Context, Effect, type Schema, type Layer, type Scope } from "effect"
import { AsyncResult, Atom as NativeAtom } from "effect/unstable/reactivity"
import { atom, type Atom, type Getter } from "./atom"
import { createActorStore, type ActorRuntime, type Requirements } from "./host"
import type { Recorded } from "./internal/effects"
import type { Journal } from "./journal"
import { createStore } from "./store"
import { EventLog } from "./durable"

type Actions<Event> = Readonly<Record<string, (...args: never[]) => Event>>
type Bound<Definitions> = { readonly [Key in keyof Definitions]: Definitions[Key] extends (...args: infer Args) => unknown ? (...args: Args) => Promise<void> : never }
type Resolved<Value> = Value extends AsyncResult.AsyncResult<infer Output, unknown> ? Output : Value

// resolveOutput unwraps synchronously evaluated projections; suspended projections cannot participate in synchronous replay.
function resolveOutput<Value>(value: Value): Resolved<Value> {
  if (AsyncResult.isAsyncResult(value)) {
    if (value.waiting || AsyncResult.isInitial(value)) throw new RuntimeError("Actor projections must resolve synchronously; return asynchronous work as an effect value")
    return AsyncResult.getOrThrow(value) as Resolved<Value>
  }
  return value as Resolved<Value>
}

export interface ActorAtom<Value, Event extends object> extends Atom<Value> {
  readonly schema: Schema.Schema<Event>
  readonly validate?: (event: Event, get: Getter) => void
}

// defineActor builds an atom graph and binds its typed actions for each actor instance.
export function defineActor<Event extends object, Value, const Name extends string, const Definitions extends Actions<NoInfer<Event>>, Services>(name: Name, factory: Effect.Effect<{
  readonly atom: ActorAtom<Value, Event>
  readonly actions: Definitions
}, Error, Services>) {
  if (!name || name.includes("/")) throw new RuntimeError("Actor name must be nonempty and contain no slash")
  type Output = Resolved<Value>
  type Atoms = { readonly [Key in Name]: ActorAtom<Output, Event> }
  const create = async (options: {
    readonly services: (runtime: ActorRuntime<Event>) => Layer.Layer<Requirements<Atoms> | Exclude<Services, Scope.Scope>, Error>
    readonly events?: readonly Recorded<Event>[]
    readonly journal?: Journal<Event>
    readonly onEvent?: (event: Recorded<Event>) => void
  }) => {
    let root!: ActorAtom<Output, Event>
    let methods!: Bound<Definitions>
    const store = await createActorStore({
      ...options,
      setup: factory.pipe(Effect.map(definition => {
        for (const action of ["getState", "subscribe", "methods"]) {
          if (Object.hasOwn(definition.actions, action)) throw new RuntimeError(`Invalid actor action: ${action}`)
        }
        root = Object.assign(atom(get => resolveOutput(get(definition.atom))), {
          schema: definition.atom.schema,
          ...(definition.atom.validate ? { validate: definition.atom.validate } : {}),
        })
        return {
          schema: definition.atom.schema,
          effects: { [name]: root } as Atoms,
          validate: (event: Event, get: Getter) => definition.atom.validate?.(event, get),
          actions: (emit: (event: Event) => Promise<void>) => {
            methods = Object.fromEntries(Object.entries(definition.actions).map(([name, action]) => [
              name, (...args: never[]) => Promise.resolve().then(() => emit(action(...args))),
            ])) as Bound<Definitions>
            return methods
          },
        }
      })),
    })
    const getState = (): Output => store.get(root)
    const subscribe = (listener: (state: Output, previous: Output) => void) => {
      let previous = getState()
      return store.sub(root, () => {
        const state = getState()
        if (Object.is(state, previous)) return
        const before = previous
        previous = state
        listener(state, before)
      })
    }
    return { ...store, getState, subscribe, methods }
  }
  const graph = () => Effect.scoped(Effect.gen(function* () {
    const definition = yield* factory
    const root = atom(get => resolveOutput(get(definition.atom)))
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => createStore(Context.make(EventLog, {
        events: atom<readonly unknown[]>([]).pipe(NativeAtom.withLabel("events")),
      }))),
      store => Effect.try({ try: () => store.graph({ [name]: root }), catch: RuntimeError.from }),
      store => Effect.sync(() => store.dispose()),
    )
  }))
  return Object.assign(create, { actorName: name, graph })
}
