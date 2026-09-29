import { Effect, Schema } from "effect"
import { atom, defineActor, durableAtom } from "@clavia/tardigrade-experimental-core"

const Message = Schema.Struct({ type: Schema.Literal("MessageReceived"), text: Schema.String })
const messages = durableAtom({
  input: Message,
  schema: Schema.Array(Schema.String),
  initial: [],
  reduce: (state, event: typeof Message.Type) => [...state, event.text],
})
export const actor = defineActor("inbox", Effect.succeed({
  atom: Object.assign(atom(get => ({ messages: get(messages) })), { schema: Message }),
  actions: { message: (input: { text: string }): typeof Message.Type => ({ type: "MessageReceived", text: input.text }) },
}))
