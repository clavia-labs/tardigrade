import { ModelInfo, ToolCatalog, actorContext } from "../actor/context"
import { modelInfo, modelActs, ModelLock, Model } from "./model"
import { askPermission, PermissionRequests } from "./decisions"
import { toolActs } from "./tools"
import { Actor, RuntimeError, type ActorCaller, type ActorRuntime, type RuntimeEvent, type ActorDefinition, type ActorOutput, type EffectExecution, type ActService, Promises, localActors, createActorStore } from "@clavia/tardigrade-core"
import { Effect, Layer, Schema } from "effect"
import { Workspace, memoryWorkspace, AgentMessage, AgentBudget, DEFAULT_AGENT_TOOL_CALLS, fetch, alarm, workspace, agents, type LibraryImplementation } from "@clavia/tardigrade-libraries"
import { createActor } from "../agent"
import { budgetState } from "../atoms/durable/budget"
import { Event } from "../contracts/events"
import { turnOutput } from "../atoms/durable/inference"

export interface AssistantContext {
  readonly depth: number
  readonly parent: ActorCaller | undefined
}

type AgentActs = ActService<"agent.model.generate"> | ActService<"agent.model.retry.wait"> | ActService<"agent.model.summarize"> | ActService<"agent.tool.execute"> | ActService<"agent.permission.request">

type AssistantDefinition<Services> = ActorDefinition<Event, ActorOutput<unknown, Event, Services | AgentActs>, ModelInfo | ToolCatalog>

export interface AssistantOptions<Services = never> {
  readonly actor?: AssistantDefinition<Services>
  readonly services: Layer.Layer<Model | ModelLock | Promises | PermissionRequests | Services, Error, Actor> | ((context: AssistantContext, host: ActorRuntime<Event>) => Layer.Layer<Model | ModelLock | Promises | PermissionRequests | Services, Error, Actor>)
  readonly libraries?: readonly LibraryImplementation<Services | Actor | Workspace | Promises | EffectExecution>[]
  readonly maxChildDepth: number
  readonly onEvent?: (event: RuntimeEvent<Event>, depth: number) => void
}

// assistantServices supplies local child actors while the host chooses model and promise implementations.
export function assistantServices<Services>(host: ActorRuntime<Event>, options: AssistantOptions<Services>, depth: number, parent?: ActorCaller, budget?: typeof AgentBudget.Type): Layer.Layer<ModelInfo | ToolCatalog | AgentActs | Model | ModelLock | Promises | Actor | Workspace | Services, Error> {
  const children = localActors({
    run: (call, caller) => Effect.gen(function* () {
      if (depth >= options.maxChildDepth) return yield* Effect.fail(new RuntimeError(`Child depth limit reached: ${options.maxChildDepth}`))
      const actor: AssistantDefinition<Services> = options.actor ?? createActor
      if (call.target.actor !== actor.actorName) return yield* Effect.fail(new RuntimeError(`Unknown actor: ${call.target.actor}`))
      if (call.method !== "message") return yield* Effect.fail(new RuntimeError(`Unknown agent method: ${call.method}`))
      const input = yield* Schema.decodeUnknownEffect(AgentMessage)(call.input).pipe(Effect.mapError(RuntimeError.from))
      const childBudget = input.budget ?? { toolCalls: DEFAULT_AGENT_TOOL_CALLS }
      let childRuntime!: ActorRuntime<Event>
      const configuration = assistantRuntime(options, depth + 1, caller, childBudget)
      return yield* Effect.acquireUseRelease(
        createActorStore({ actor, ...configuration, services: runtime => {
          childRuntime = runtime
          return configuration.services(runtime)
        } }),
        child => Effect.gen(function* () {
          yield* childRuntime.send([{ type: "TurnRequested", text: input.text, turnId: call.id }])
          yield* child.wait
          const reply = child.snapshot().events.filter(Schema.is(Event)).findLast(event => event.type === "TurnSettled")
          if (!reply || reply.type !== "TurnSettled") return yield* Effect.fail(new RuntimeError("Child finished without an answer"))
          return { answer: turnOutput(child.snapshot().events.filter(Schema.is(Event)), reply) }
        }).pipe(Effect.onInterrupt(() => caller.cancelled() ? Effect.gen(function* () {
          const snapshot = child.snapshot()
          const refs = [...snapshot.pending().map(work => work.ref), ...snapshot.deferred().map(work => work.ref)]
          for (const ref of refs) yield* child.cancel(ref, "Parent invocation cancelled")
          yield* child.wait
        }) : Effect.void)),
        child => child.close,

      )
    }),
    onRequest: (handle, request) => host.send([{ type: "ActorRequestReceived", handle, request }, { type: "TurnRequested", source: "agent", turnId: `request:${JSON.stringify([handle, request.requestId])}`, text: `Child request (data): ${JSON.stringify({ handle, ...request })}` }]),
    onReply: (handle, requestId, result) => host.record({ type: "ActorReplyReceived", handle, requestId, result }),
    onMessage: (handle, message) => host.send([{ type: "TurnRequested", source: "agent", turnId: `${handle.id}:notice:${crypto.randomUUID()}`, text: JSON.stringify({ handle, message }) }]),
  })
  const services = typeof options.services === "function" ? options.services({ depth, parent }, host) : options.services
  const platform = Layer.mergeAll(services, memoryWorkspace, Layer.effectDiscard(budget ? host.onReady(Effect.suspend(() => host.record({
    type: host.get(budgetState).some(entry => entry.metric === "toolCalls") ? "BudgetUpdated" : "BudgetConfigured",
    metric: "toolCalls", policy: { limit: budget.toolCalls, onExhausted: "deny" },
  }))) : Effect.void)).pipe(Layer.provideMerge(children))
  return Layer.mergeAll(modelInfo, modelActs, askPermission, toolActs(options.libraries ?? [fetch(), alarm(), workspace(), agents({ actor: (options.actor ?? createActor).actorName })])).pipe(Layer.provideMerge(platform))
}

// assistantRuntime configures services and observation for one level of child actors.
export function assistantRuntime<Services = never>(options: AssistantOptions<Services>, depth = 0, parent?: ActorCaller, budget?: typeof AgentBudget.Type) {
  if (!Number.isSafeInteger(options.maxChildDepth) || options.maxChildDepth < 0) throw new RuntimeError("maxChildDepth must be a nonnegative integer")
  return {
    actorContext,
    services: (host: ActorRuntime<Event>) => assistantServices(host, options, depth, parent, budget),
    onEvent: (event: RuntimeEvent<Event>) => options.onEvent?.(event, depth),
  }
}
