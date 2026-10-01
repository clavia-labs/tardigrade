import { Effect, Schema } from "effect"
import { actorMethod, event, atom, defineActor, durableAtom } from "@clavia/tardigrade-experimental-core"

const Message = event({ type: "NoteReceived", id: Schema.String, text: Schema.String })
const messages = durableAtom({ name: "examples.inbox.messages",
  input: Message,
  schema: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
  initial: [],
  reduce: (state, event: typeof Message.Type) => [...state, { id: event.id, text: event.text }],
})
export const actor = defineActor("inbox", Effect.succeed({
  atom: atom(get => ({ messages: get(messages) })), methods: {
    message: actorMethod({
      inputSchema: Schema.Struct({ text: Schema.String }), outputSchema: Schema.String,
      onReceive: Message.from((input, context) => ({ id: context.id, text: input.text })),
      result: (_, get, context) => {
        const message = get(messages).find(message => message.id === context.id)
        return message ? { status: "completed" as const, output: message.text } : undefined
      },
    }),
  },
}))
