import { agentMethods } from "./actor/methods"
import { Effect } from "effect"
import { atom, defineActor, type ActorMethods } from "@clavia/tardigrade-core"
import { messages } from "./atoms/durable/index"
import { toolBudget } from "./atoms/budget-request"
import { compact, type CompactionOptions } from "./atoms/compact"
import { infer } from "./atoms/infer"
import { permissions } from "./atoms/permission-request"
import { systemPrompt } from "./atoms/system"
import { tools as libraryTools, withPermissions, withBudget } from "./atoms/tools"
import { pendingTools } from "./atoms/durable/tools"
import type { LibrarySource } from "@clavia/tardigrade-libraries/types"

export interface AgentOptions<Methods extends ActorMethods<object> = {}> {
  /** name identifies the actor for hosts and clients. */
  readonly name: string
  /** system supplies the model prompt. */
  readonly system: string
  /** tools selects libraries; omission offers every library the host supplies. */
  readonly tools?: readonly LibrarySource[]
  /** compaction configures history summarization and retention. */
  readonly compaction?: CompactionOptions
  /** methods supplies custom actor endpoints. */
  readonly methods?: Methods
}

// agent composes message history, compaction, tools, and inference into an actor.
export const agent = <const Methods extends ActorMethods<object> = {}>(options: AgentOptions<Methods>) => defineActor(options.name, Effect.gen(function* () {
  const system = systemPrompt(options.system)
  const tools = yield* libraryTools(options.tools)
  const context = yield* compact(messages, options.compaction)
  const inference = yield* infer(atom(get => ({
    system: get(system),
    tools: get(tools),
    context: get(context),
  })))
  return { atom: inference, methods: { ...agentMethods, ...options.methods } as typeof agentMethods & Methods }
}))

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
