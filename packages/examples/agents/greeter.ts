import { Effect, Schema } from "effect"
import { act, defineActor, effectAtom } from "@clavia/tardigrade-core"

export const Greet = act({
  name: "greet",
  input: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  failure: Schema.String,
})

export const greeter = defineActor("greeter", Effect.sync(() => {
  const greeting = Greet.request({
    input: { name: "Arjun" },
    onSettled: result => result.status === "fulfilled" ? [{ type: "Greeted", message: result.value }] : [],
  })
  return {
    atom: effectAtom(get => ({
      view: get(greeting.result),
      events: {}, acts: { greeting },
    })), schema: Schema.Struct({ type: Schema.Literal("Greeted"), message: Schema.String }),
  }
}))
