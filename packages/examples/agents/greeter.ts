import { Effect, Schema } from "effect"
import { act, defineActor, durableAtom, effectAtom, event } from "@clavia/tardigrade-core"

export const Greet = act({
  name: "greet",
  input: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  failure: Schema.String,
})

const Greeted = event({ type: "Greeted", message: Schema.String })
const GreetingFailed = event({ type: "GreetingFailed", reason: Schema.Json })
const Event = Schema.Union([Greeted, GreetingFailed])
const greetingState = durableAtom({ name: "greeter.greeting", input: Event,
  schema: Schema.Union([Schema.Struct({ status: Schema.Literal("pending") }), Schema.Struct({ status: Schema.Literal("fulfilled"), value: Schema.String }), Schema.Struct({ status: Schema.Literal("rejected"), reason: Schema.Json })]),
  initial: { status: "pending" }, reduce: (_, entry) => entry.type === "Greeted" ? { status: "fulfilled" as const, value: entry.message } : { status: "rejected" as const, reason: entry.reason },
})

export const greeter = defineActor("greeter", Effect.sync(() => {
  const greeting = Greet.request({ input: { name: "Arjun" },
    onSettled: result => result.status === "fulfilled" ? [Greeted.make({ message: result.value })] : [GreetingFailed.make({ reason: result.reason })],
  })
  return {
    atom: effectAtom(get => ({ view: get(greetingState), events: {}, acts: get(greetingState).status === "pending" ? { greeting } : {} })),
    schema: Event,
  }
}))
