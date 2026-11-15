import type { Requirements } from "@clavia/tardigrade-core/runtime/contracts"
import { Context, Effect, Layer, Schema } from "effect"
import { Rpc } from "effect/rpc"
import { Agent, AskBudget, AskPermission, ModelInfo, pendingTools, permissions, toolBudget } from "@clavia/tardigrade-agent"
import { actorMethod, defineActor, event } from "@clavia/tardigrade-core"
import { Library } from "@clavia/tardigrade-libraries"
import { host as bunHost } from "../../src/bun"
import { host as cloudflareHost } from "../../src/cloudflare"
import { contentModelServices } from "../fixtures/agent"

const reader = Library.make("reader", Rpc.make("read", { payload: Schema.Struct({ key: Schema.String }), success: Schema.String }))
const other = Library.make("other", Rpc.make("read", { payload: Schema.Struct({ key: Schema.String }), success: Schema.String }))
class Instructions extends Context.Service<Instructions, string>()("agent-composition/Instructions") {}
class UserInstructions extends Context.Service<UserInstructions, string>()("agent-composition/UserInstructions") {}
class LibraryInstructions extends Context.Service<LibraryInstructions, string>()("agent-composition/LibraryInstructions") {}

export function compositionRetainsRuntimeRequirements() {
  const contextual = reader.pipe(Library.context({ system: LibraryInstructions, user: UserInstructions }))
  const program = Effect.gen(function* () {
    const tools = yield* Agent.tools([contextual])
    const context = yield* Agent.compact(Agent.messages)
    return yield* Agent.make({ system: Instructions, tools, context })
  })
  const assistant = defineActor("typed", program)
  const model = contentModelServices(() => {})
  const implementation = Layer.succeed(reader, { read: ({ key }) => Effect.succeed(key) })
  const instructions = Layer.succeed(Instructions, "Read notes.")
  const libraryInstructions = Layer.succeed(LibraryInstructions, "Use reader.")
  const userInstructions = Layer.succeed(UserInstructions, "Current files.")
  const layer = Layer.mergeAll(model, implementation, instructions, libraryInstructions, userInstructions)
  const runtime = bunHost(assistant, { storage: ".unused", layer })
  const worker = cloudflareHost(assistant, { layer })
  const construction: Effect.Effect<unknown, Error, ModelInfo> = program
  const dependencies: Layer.Layer<Layer.Success<typeof assistant.layer>, Error, ModelInfo | typeof reader.Identifier | Instructions | LibraryInstructions | UserInstructions> = assistant.layer

  // @ts-expect-error Tool declarations retain their service identity.
  const missingTool = bunHost(assistant, { storage: ".unused", layer: Layer.mergeAll(model, instructions, libraryInstructions, userInstructions) })
  // @ts-expect-error Same-shaped libraries with another name do not satisfy reader.
  const wrongTool = cloudflareHost(assistant, { layer: Layer.mergeAll(model, instructions, libraryInstructions, userInstructions, Layer.succeed(other, { read: ({ key }) => Effect.succeed(key) })) })
  // @ts-expect-error Dynamic actor prompts retain their service requirements.
  const missingPrompt = cloudflareHost(assistant, { layer: Layer.mergeAll(model, implementation, libraryInstructions, userInstructions) })
  // @ts-expect-error Dynamic library prompts retain their service requirements.
  const missingLibraryPrompt = bunHost(assistant, { storage: ".unused", layer: Layer.mergeAll(model, implementation, instructions, userInstructions) })
  // @ts-expect-error Dynamic user prompts retain their service requirements.
  const missingUserPrompt = cloudflareHost(assistant, { layer: Layer.mergeAll(model, implementation, instructions, libraryInstructions) })
  const toolAdapter: Extract<Layer.Success<typeof assistant.layer>, { readonly act: "agent.tool.execute" }> = { act: "agent.tool.execute" }
  const contextAdapter: Extract<Layer.Success<typeof assistant.layer>, { readonly act: "agent.context.resolve" }> = { act: "agent.context.resolve" }
  // @ts-expect-error Graph construction requires model metadata.
  const missingModel = bunHost(assistant, { storage: ".unused", layer: Layer.mergeAll(implementation, instructions, libraryInstructions, userInstructions) })

  return { runtime, worker, construction, dependencies, missingTool, wrongTool, missingPrompt, missingLibraryPrompt, missingUserPrompt, missingModel, toolAdapter, contextAdapter }
}

export function toolWrappersRetainDecisionRequirements() {
  const assistant = defineActor("governed", Effect.gen(function* () {
    const available = yield* Agent.tools([reader])
    const permission = permissions(pendingTools, { tools: available })
    const permitted = Agent.withPermissions(available, permission)
    const tools = Agent.withBudget(permitted, toolBudget(pendingTools, { maxCalls: 1, requestTool: "request_budget" }))
    const libraries: readonly [typeof reader] = tools.libraries
    const context = yield* Agent.compact(Agent.messages)
    return yield* Agent.make({ system: libraries[0].name, tools, context })
  }))
  type Requests = Requirements<{ root: Effect.Success<typeof assistant.setup>["root"] }>
  const permissionRequirement: Extract<Requests, { readonly act: "agent.permission.request" }> = { act: "agent.permission.request" }
  const budgetRequirement: Extract<Requests, { readonly act: "agent.budget.request" }> = { act: "agent.budget.request" }
  const model = contentModelServices(() => {})
  const implementation = Layer.succeed(reader, { read: ({ key }) => Effect.succeed(key) })
  const permission = AskPermission.layer(() => Effect.succeed({ allowed: true, reason: "Test" }))
  const budget = AskBudget.layer(() => Effect.succeed({ allowed: false, reason: "Test" }))
  const layer = Layer.mergeAll(model, implementation, permission, budget)
  const runtime = bunHost(assistant, { storage: ".unused", layer })
  const worker = cloudflareHost(assistant, { layer })

  // @ts-expect-error Permission wrappers retain their decision service requirement.
  const missingPermission = bunHost(assistant, { storage: ".unused", layer: Layer.mergeAll(model, implementation, budget) })
  // @ts-expect-error Budget wrappers retain their decision service requirement.
  const missingBudget = cloudflareHost(assistant, { layer: Layer.mergeAll(model, implementation, permission) })

  return { runtime, worker, permissionRequirement, budgetRequirement, missingPermission, missingBudget }
}

export function emptyToolsAndCustomMethodsRetainContracts() {
  const Echoed = event({ type: "Echoed", text: Schema.String })
  const echo = actorMethod({
    inputSchema: Schema.String, outputSchema: Schema.String,
    onReceive: Echoed.from(text => ({ text })),
    result: input => ({ status: "completed", output: input }),
  })
  const assistant = defineActor("custom", Effect.gen(function* () {
    const tools = yield* Agent.tools([])
    const context = yield* Agent.compact(Agent.messages)
    return yield* Agent.make({ system: "Test", tools, context, methods: { echo, message: echo } })
  }))
  const runtime = bunHost(assistant, { storage: ".unused", layer: contentModelServices(() => {}) })
  const contracts = Effect.map(assistant.inspect, inspection => {
    const echoInput: typeof inspection.methods.echo.inputSchema.Type = "hello"
    const messageInput: typeof inspection.methods.message.inputSchema.Type = "override"
    const messageOutput: typeof inspection.methods.message.outputSchema.Type = "override"
    // @ts-expect-error Custom method inputs retain their schema.
    const invalid: typeof inspection.methods.echo.inputSchema.Type = 123
    // @ts-expect-error Overriding message replaces the standard input contract.
    const invalidMessage: typeof inspection.methods.message.inputSchema.Type = { text: "original" }
    return { echoInput, messageInput, messageOutput, invalid, invalidMessage }
  })
  return { runtime, contracts }
}

export function toolsRequireExecutableDeclarations() {
  // @ts-expect-error A library name alone does not declare executable bindings.
  const unbound = Agent.tools([{ name: "reader" }])
  // @ts-expect-error Tool declarations must be an array.
  const invalid = Agent.tools(reader)
  return { unbound, invalid }
}
