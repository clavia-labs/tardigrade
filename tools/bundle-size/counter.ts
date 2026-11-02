import { Effect, Schema } from "effect"
import { actorMethod, defineActor, durableAtom, event } from "tardie/core"

export const Incremented = event({ type: "Incremented" })

export const counter = defineActor("counter", Effect.sync(() => {
  const count = durableAtom({ name: "count", input: Incremented, schema: Schema.Int, initial: 0, reduce: count => count + 1 })
  return {
    atom: count,
    methods: {
      increment: actorMethod({
        inputSchema: Schema.Null,
        outputSchema: Schema.Int,
        onReceive: Incremented.from(() => ({})),
        result: (_input, get) => ({ status: "completed", output: get(count) }),
      }),
    },
  }
}))
