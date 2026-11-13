import { Layer } from "effect"
import { contextConfiguration, contextServices } from "./services/context"
import { agentDefinition, type AgentOptions } from "./actor/definition"
import { libraryServices } from "./services/tools"
import type { ActorMethods } from "@clavia/tardigrade-core"

export { createActor, type AgentOptions } from "./actor/definition"

// agent supplies tool and context runtimes through the actor definition's layer.
export const agent = <const Options extends AgentOptions<ActorMethods<object>>>(options: Options) => {
  const definition = agentDefinition(options, contextConfiguration(options.system, options.tools ?? []))
  const context = contextServices<Options["system"], typeof definition.libraries>(options.system, definition.libraries)
  return { ...definition, layer: Layer.merge(libraryServices(definition.libraries), context) }
}
