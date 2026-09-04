import { Context, Effect, Layer, Schema } from "effect"
import { actor, actorMethod, component } from "tardie"
import type { Event } from "@clavia/tardigrade-core/event"
import { effect } from "@clavia/tardigrade-core/effect"

import type { DevLayersFor } from "../../src/dev"

class Greeting extends Context.Service<Greeting, { readonly prefix: string; readonly thread: string }>()(
  "tardigrade/dev-test/Greeting"
) {}

interface GreetingState {
  readonly requests: ReadonlyMap<string, string>
  readonly replies: ReadonlyMap<string, string>
}

const initial = (): GreetingState => ({ requests: new Map(), replies: new Map() })
const step = (state: GreetingState, event: Event): GreetingState => {
  const value = event as { readonly id?: unknown; readonly text?: unknown }
  const id = String(value.id ?? "")
  if (event.type === "GreetingRequested") return { ...state, requests: new Map(state.requests).set(id, String(value.text ?? "")) }
  if (event.type === "GreetingCompleted") return { ...state, replies: new Map(state.replies).set(id, String(value.text ?? "")) }
  return state
}

const greet = actorMethod({
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.String,
  event: ({ invocation, input, at }) => ({ type: "GreetingRequested", id: invocation.id, text: input.text, at }),
  projection: {
    initial,
    step,
    output: (state) => ({
      currentEpoch: () => 0,
      invocationState: (invocation) => {
        if (!state.requests.has(invocation.id)) return undefined
        const reply = state.replies.get(invocation.id)
        return reply === undefined ? { status: "pending" as const } : { status: "completed" as const, output: reply }
      }
    })
  }
})

export const layeredActor = actor({
  name: "layered",
  methods: { greet },
  components: [component({
    name: "greeting",
    keys: {
      prefixes: ["greeting-request:", "greeting-complete:"],
      keyOf: (event) => {
        const id = String((event as { readonly id?: unknown }).id ?? "")
        if (event.type === "GreetingRequested") return `greeting-request:${id}`
        if (event.type === "GreetingCompleted") return `greeting-complete:${id}`
        return undefined
      }
    },
    initial,
    step,
    output: (state) => ({
      view: undefined,
      transitions: [...state.requests].flatMap(([id, text]) => state.replies.has(id) ? [] : [effect({
        key: `greeting:${id}`,
        input: { id, text },
        act: (input) => Effect.gen(function*() {
          const greeting = yield* Greeting
          return [{ type: "GreetingCompleted", ...input, text: `${greeting.prefix}:${greeting.thread}:${input.text}` }]
        })
      })])
    })
  })]
})

export const layeredLayersFor = (({ actorInstance, thread }) =>
  Layer.succeed(Greeting, { prefix: actorInstance, thread })) satisfies DevLayersFor<typeof layeredActor>
