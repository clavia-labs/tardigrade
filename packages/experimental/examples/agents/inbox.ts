import { Effect, Schema } from "effect"
import { actorMethod, atom, defineActor, durableAtom } from "@clavia/tardigrade-experimental-core"

const Message = Schema.Struct({ type: Schema.Literal("MessageReceived"), id: Schema.String, text: Schema.String })
const messages = durableAtom({ name: "examples.inbox.messages",
  input: Message,
  schema: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
  initial: [],
  reduce: (state, event: typeof Message.Type) => [...state, { id: event.id, text: event.text }],
})
export const actor = defineActor("inbox", Effect.succeed({
  atom: Object.assign(atom(get => ({ messages: get(messages) })), { schema: Message, methods: {
    message: actorMethod({
      inputSchema: Schema.Struct({ text: Schema.String }), outputSchema: Schema.String,
      onReceive: (input, context) => ({ type: "MessageReceived" as const, id: context.id, text: input.text }),
      result: (_, get, context) => {
        const message = get(messages).find(message => message.id === context.id)
        return message ? { status: "completed" as const, output: message.text } : undefined
      },
    }),
  } }),
  actions: {},
}))
