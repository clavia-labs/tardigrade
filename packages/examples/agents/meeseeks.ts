import { agentMethods } from "@clavia/tardigrade-agent/actor/methods"
import { Effect } from "effect"
import { atom, Actor } from "@clavia/tardigrade-core"
import { compact, infer, tools as libraryTools, messages } from "@clavia/tardigrade-agent/atoms"

export const meeseeks = Actor.make("meeseeks", Effect.gen(function* () {
  const system = atom("You are a helpful assistant. Keep answers concise and practical.")
  const tools = yield* libraryTools()
  const context = yield* compact(messages)
  const agent = yield* infer(get => ({
    system: get(system),
    tools: get(tools),
    context: get(context),
  }))
  return { atom: agent, methods: agentMethods }
}))
