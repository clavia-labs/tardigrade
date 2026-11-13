import { agentDefinition, type AgentOptions } from "./actor/definition"
import { libraryServices } from "./services/tools"
import type { ActorMethods } from "@clavia/tardigrade-core"

export { createActor, type AgentOptions } from "./actor/definition"

// agent supplies its tool runtime through the actor definition's layer.
export const agent = <const Options extends AgentOptions<ActorMethods<object>>>(options: Options) => {
  const definition = agentDefinition(options)
  return { ...definition, layer: libraryServices(definition.libraries) }
}
