import { agentMethods } from "./methods"
import { Effect } from "effect"
import { atom, defineActor, type ActorMethods } from "@clavia/tardigrade-core"
import { messages, messagesWithContext } from "../atoms/durable/index"
import { toolBudget } from "../atoms/budget-request"
import { compact, type CompactionOptions } from "../atoms/compact"
import { infer } from "../atoms/infer"
import { prepareContext } from "../atoms/context"
import type { ContextConfiguration } from "../contracts/context"
import { permissions } from "../atoms/permission-request"
import { systemPrompt } from "../atoms/system"
import { tools as libraryTools, withPermissions, withBudget } from "../atoms/tools"
import { pendingTools } from "../atoms/durable/tools"
import type { LibraryBinding } from "@clavia/tardigrade-libraries"
import { actorContext } from "./context"

export interface AgentOptions<Methods extends ActorMethods<object> = {}, Libraries extends readonly LibraryBinding[] = readonly LibraryBinding[]> {
  /** name identifies the actor for hosts and clients. */
  readonly name: string
  /** system supplies the model prompt. */
  readonly system: string | Effect.Effect<string, unknown, unknown>
  /** tools selects libraries for the agent's tool runtime. */
  readonly tools?: Libraries
  /** compaction configures history summarization and retention. */
  readonly compaction?: CompactionOptions
  /** methods supplies custom actor endpoints. */
  readonly methods?: Methods
}

type DeclaredMethods<Options> = Options extends { readonly methods?: infer Methods extends ActorMethods<object> } ? Methods : {}
type DeclaredLibraries<Options> = Options extends { readonly tools?: infer Libraries extends readonly LibraryBinding[] } ? Libraries : readonly []

// agent composes message history, compaction, tools, and inference into an actor.
export const agentDefinition = <const Options extends AgentOptions<ActorMethods<object>>>(options: Options, configuration: ContextConfiguration) => {
  const libraries = (options.tools ?? []) as DeclaredLibraries<Options>
  const actor = defineActor(options.name, Effect.gen(function* () {
    const preparation = prepareContext(configuration)
    const tools = yield* libraryTools(options.tools)
    const history = configuration.contributions.length ? messagesWithContext({
      contributions: configuration.contributions.map(source => ({ library: source.library, ...(source.user === undefined ? {} : { user: source.user }) })),
    }) : messages
    const context = yield* compact(history, options.compaction)
    const inference = yield* infer(atom(get => ({
      system: "",
      preparation: get(preparation),
      tools: get(tools),
      context: get(context),
    })))
    return { atom: inference, methods: { ...agentMethods, ...options.methods } as typeof agentMethods & DeclaredMethods<Options> }
  }))
  return {
    ...actor,
    actorContext,
    libraries,
  }
}

export const createActor = defineActor("tardie", Effect.gen(function* () {
  const available = yield* libraryTools()
  const permission = permissions(pendingTools, { tools: available })
  const permitted = withPermissions(available, permission)
  const budget = toolBudget(pendingTools, { configure: false })
  const tools = withBudget(permitted, budget)
  const system = systemPrompt("You are a friendly assistant.")
  const context = yield* compact(messages)

  const input = atom(get => ({
    system: get(system),
    tools: get(tools),
    context: get(context),
  }))
  const inference = yield* infer(input)
  return { atom: inference, methods: agentMethods }
}))
