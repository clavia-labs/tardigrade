import { Context, Deferred, Effect, Schema } from "effect"
import { act, createActorStore, defineActor, durableMerkleAtom, durableLogAtom, effectAtom, type ActorRuntime, type EffectRef, type Journal } from "@clavia/tardigrade-core"

const Message = Schema.Struct({ text: Schema.String })
const Added = Schema.Struct({ type: Schema.Literal("Added"), messages: Schema.Array(Message) })
const Started = Schema.Struct({ type: Schema.Literal("Started") })
const Finished = Schema.Struct({ type: Schema.Literal("Finished") })
export const TreeEvent = Schema.Union([Added, Started, Finished])
const State = Schema.Struct({ messages: Schema.Array(Message), origin: Schema.Int, done: Schema.Boolean })
const Job = act({ name: "tree-job", input: Schema.Struct({ messages: Schema.Array(Message) }), success: Schema.Int, failure: Schema.String })

export function treeActorFixture(journal: Journal<typeof TreeEvent.Type>, observe: (phase: "execution" | "cleanup", input: { readonly messages: readonly { readonly text: string }[] }, ref: EffectRef) => Effect.Effect<void, never>, checkpointOptions?: { readonly maxBytes: number }, kind: "tree" | "log" = "tree") {
  const { trees: _trees, ...logJournal } = journal
  let send!: ActorRuntime<typeof TreeEvent.Type>["send"]
  const execution = Deferred.makeUnsafe<void>()
  const cleanup = Deferred.makeUnsafe<void>()
  const actor = defineActor("tree-fixture", Effect.sync(() => {
    const history = durableMerkleAtom({ name: "history", schema: State, input: TreeEvent, initial: { messages: [], origin: -1, done: false }, reduce: (state, event, _metadata, position) => {
      if (event.type === "Added") return state.append(["messages"], event.messages)
      return event.type === "Started" ? state.set(["origin"], position) : state.set(["done"], true)
    } })
    const logged = durableLogAtom({ name: "history", entry: Message, input: TreeEvent, meta: { schema: Schema.Struct({ origin: Schema.Int, done: Schema.Boolean }), initial: { origin: -1, done: false } }, reduce: (state, event, _metadata, position) => {
      if (event.type === "Added") return { ...state, log: state.log.append(event.messages) }
      return { ...state, meta: event.type === "Started" ? { ...state.meta, origin: position } : { ...state.meta, done: true } }
    } })
    let cached: { origin: number; request: ReturnType<typeof Job.requestTree> } | undefined
    return { schema: TreeEvent, atom: effectAtom(get => {
      const state = kind === "tree" ? get(history) : undefined
      const log = kind === "log" ? get(logged) : undefined
      const origin = log ? log.meta.origin : state!.read(["origin"])
      const done = log ? log.meta.done : state!.read(["done"])
      if (origin >= 0 && !done && cached?.origin !== origin) cached = { origin, request: Job.requestTree({ origin, input: { messages: log ? log.log.select(0, log.log.length) : state!.select(["messages"]) }, onSettled: () => [{ type: "Finished" }] }) }
      return {
        view: { count: log ? log.log.length : state!.length(["messages"]), done }, events: {},
        acts: origin < 0 || done ? {} : { job: cached!.request },
      }
    }) }
  }))
  return Effect.map(createActorStore({ actor, journal: kind === "log" ? logJournal : journal, checkpoint: { mode: "manual", ...(checkpointOptions ? { options: checkpointOptions } : {}) }, attemptTimeoutMs: null, actorContext: Context.pick(),
    services: runtime => { send = runtime.send; return Job.layer((input, { ref }) => observe("execution", input, ref).pipe(Effect.andThen(Deferred.await(execution)), Effect.as(input.messages.length)), {
      cancel: (input, { ref }) => observe("cleanup", input, ref).pipe(Effect.andThen(Deferred.await(cleanup))),
    }) },
  }), store => ({
    store,
    finish: Deferred.succeed(execution, undefined),
    finishCleanup: Deferred.succeed(cleanup, undefined),
    seed: Effect.suspend(() => send([{ type: "Added", messages: Array.from({ length: 4096 }, (_, n) => ({ text: `${n}:${"x".repeat(2048)}` })) }])),
    start: Effect.suspend(() => send([{ type: "Started" }])),
    append: Effect.suspend(() => send([{ type: "Added", messages: [{ text: "late" }] }])),
  }))
}
