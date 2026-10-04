import { Context, Effect, Schema } from "effect"
import { act, actorMethod, defineActor, durableAtom, effectAtom, event, Invocation, Supervisor, ThreadCoordinate } from "@clavia/tardigrade-core"
import { createActorWorker, cloudflareThreadName } from "../../src/cloudflare"

const ReadRequested = event({ type: "ReadRequested" })
const Changed = event({ type: "Changed", value: Schema.Finite })
const SpawnRequested = event({ type: "SpawnRequested", id: Schema.String, value: Schema.Finite })
const SpawnCompleted = event({ type: "SpawnCompleted", id: Schema.String, child: ThreadCoordinate })
const Event = Schema.Union([Changed, SpawnRequested, SpawnCompleted, ReadRequested])
const value = durableAtom({ name: "layout.value", input: Changed, schema: Schema.Finite, initial: 0, reduce: (_, event) => event.value })
const spawns = durableAtom({ name: "layout.spawns", input: Schema.Union([SpawnRequested, SpawnCompleted]),
  schema: Schema.Array(Schema.Struct({ id: Schema.String, value: Schema.Finite, child: Schema.NullOr(ThreadCoordinate) })), initial: [],
  reduce: (state, event) => event.type === "SpawnRequested" ? [...state, { id: event.id, value: event.value, child: null }]
    : state.map(entry => entry.id === event.id ? { ...entry, child: event.child } : entry),
})
const Spawn = act({ name: "layout.spawn", input: Schema.Struct({ id: Schema.String, value: Schema.Finite }), success: ThreadCoordinate, failure: Schema.String })
const actor = defineActor("layout", Effect.sync(() => {
  const requests = new Map<string, ReturnType<typeof Spawn.request>>()
  return { schema: Event, atom: effectAtom(get => {
    const pending = get(spawns)
    return { view: get(value), events: {}, acts: Object.fromEntries(pending.filter(entry => !entry.child).map(entry => {
      let request = requests.get(entry.id)
      if (!request) {
        request = Spawn.request({ tag: entry.id, input: { id: entry.id, value: entry.value }, onSettled: result => result.status === "fulfilled" ? [{ type: "SpawnCompleted", id: entry.id, child: result.value }] : [] })
        requests.set(entry.id, request)
      }
      return [entry.id, request]
    })) }
  }), methods: {
    read: actorMethod({ inputSchema: Schema.Null, outputSchema: Schema.Finite, onReceive: ReadRequested.from(() => ({})), result: (_, get) => ({ status: "completed", output: get(value) }) }),
    set: actorMethod({ inputSchema: Schema.Finite, outputSchema: Schema.Finite, onReceive: Changed.from(value => ({ value })), result: (_, get) => ({ status: "completed", output: get(value) }) }),
    spawn: actorMethod({ inputSchema: Schema.Finite, outputSchema: ThreadCoordinate,
      onReceive: SpawnRequested.from((value, context) => ({ id: context.id, value })), result: (_, get, context) => {
        const child = get(spawns).find(entry => entry.id === context.id)?.child
        return child ? { status: "completed", output: child } : undefined
      },
    }),
  } }
}))

const paused = new Set<string>()
const worker = createActorWorker({ actor, actorContext: Context.pick(), initialStateAtoms: [value, spawns], http: env => typeof env.FIXTURE_TOKEN === "string" ? { token: env.FIXTURE_TOKEN } : {}, services: (_env, coordinate) => Spawn.layer(input => Effect.gen(function* () {
  if (paused.has(cloudflareThreadName(coordinate))) return yield* Effect.never
  const supervisor = yield* Supervisor
  const invocation = yield* Invocation
  const child = yield* supervisor.allocate({ instance: coordinate.instance, parent: coordinate, name: input.id })
  yield* invocation.send({ id: `child:${input.id}`, target: child, body: { method: "set", input: input.value } })
  return child
}).pipe(Effect.mapError(String))) })
export const LayoutActorDO = worker.ActorObject
export class LayoutThreadDO extends worker.ThreadObject {
  blockSpawns(blocked: boolean) {
    const name = this.ctx.id.name!
    if (blocked) paused.add(name)
    else paused.delete(name)
  }
}
export default { fetch: worker.fetch }
