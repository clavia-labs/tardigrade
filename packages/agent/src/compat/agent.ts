import { Layer } from "effect"
import { contextConfiguration, contextServices } from "../services/context"
import { agentDefinition, type AgentOptions } from "../actor/definition"
import { libraryCatalog, libraryServices } from "../services/tools"
import type { ActorMethods } from "@clavia/tardigrade-core"

/**
 * agent supplies tool and context runtimes through the actor definition's layer.
 * @deprecated Compose Agent.tools, Agent.compact, and Agent.make inside Actor.make.
 */
export const agent = <const Options extends AgentOptions<ActorMethods<object>>>(options: Options) => {
  const definition = agentDefinition(options, contextConfiguration(options.system, options.tools ?? []), libraryCatalog(options.tools ?? []))
  const context = contextServices<Options["system"], typeof definition.libraries>(options.system, definition.libraries)
  return { ...definition, layer: Layer.merge(libraryServices(definition.libraries), context) }
}
