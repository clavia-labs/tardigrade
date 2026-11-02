import { Effect, Schema } from "effect"
import { act, actorMethod, defineActor, durableAtom, effectAtom, event, type Atom } from "tardie/core"

const actorName = "counter"

const Incremented = event({ type: "Incremented" })
const Decremented = event({ type: "Decremented" })

const makeCount = () => durableAtom({
  name: "count",
  input: Schema.Union([Incremented, Decremented]),
  schema: Schema.Int,
  initial: 0,
  reduce: (count, event) => event.type === "Decremented" ? count - 1 : count + 1,
})

const Notify = act({
  name: "notify",
  input: Schema.Int,
  success: Schema.Null,
  failure: Schema.String,
})

export const notifyLayer = Notify.layer(count =>
  Effect.log(`${count} is even`).pipe(Effect.as(null))
)

const notify = (count: Atom<number>) => effectAtom(get => ({
  view: get(count),
  events: {},
  acts: get(count) > 0 && get(count) % 2 === 0
    ? { notify: Notify.request({ input: get(count) }) }
    : {},
}))

const counterMethods = (count: Atom<number>) => ({
  increment: actorMethod({
    inputSchema: Schema.Null,
    outputSchema: Schema.Int,
    onReceive: Incremented.from(() => ({})),
    result: (_input, get) => ({
      status: "completed",
      output: get(count),
    }),
  }),
  decrement: actorMethod({
    inputSchema: Schema.Null,
    outputSchema: Schema.Int,
    onReceive: Decremented.from(() => ({})),
    result: (_input, get) => ({
      status: "completed",
      output: get(count),
    }),
  }),
})

const counter = defineActor(actorName, Effect.sync(() => {
  const count = makeCount()
  const notifications = notify(count)

  return {
    atom: notifications,
    methods: counterMethods(count),
  }
}))

export default counter
