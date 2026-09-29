import { Effect, Schema } from "effect"
import { act, defineActor, effectAtom } from "@clavia/tardigrade-experimental-core"

export const Greet = act({
  name: "greet",
  input: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  failure: Schema.String,
})

export const greeter = defineActor("greeter", Effect.sync(() => {
  const greeting = Greet.request({
    tag: "greeting", input: { name: "Arjun" },
    onSettled: result => result.status === "fulfilled" ? [{ type: "Greeted", message: result.value }] : [],
  })
  return {
    atom: Object.assign(effectAtom(get => ({
      view: get(greeting.result),
      effects: { greeting },
    })), { schema: Schema.Union([Schema.Struct({ type: Schema.Literal("Opened") }), Schema.Struct({ type: Schema.Literal("Greeted"), message: Schema.String })]) }),
    actions: { open: () => ({ type: "Opened" as const }) },
  }
}))
