import { agentMethods } from "@clavia/tardigrade-agent/actor/methods"
import { Effect } from "effect"
import { atom, defineActor } from "@clavia/tardigrade-core"
import { compact, infer, packageTools, conversation } from "@clavia/tardigrade-agent/atoms"

export const meeseeks = defineActor("meeseeks", Effect.gen(function* () {
  const system = atom("You are a helpful assistant. Keep answers concise and practical.")
  const tools = yield* packageTools
  const context = yield* compact(conversation)
  const agent = yield* infer(atom(get => ({
    system: get(system),
    tools: get(tools),
    context: get(context),
  })))
  return { atom: agent, methods: agentMethods }
}))
