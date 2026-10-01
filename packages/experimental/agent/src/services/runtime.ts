import { ModelInfo, ToolCatalog, actorContext } from "../context"
import { modelInfo } from "./model-lock"
import { modelActs, askPermission } from "./acts"
import { PermissionRequests } from "./requests"
import { toolActs } from "./tools"
import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { Effect, Layer, Schema } from "effect"
import { Workspace, memoryWorkspace, AgentBudget, DEFAULT_AGENT_TOOL_CALLS, fetchPackage, alarm, workspace, agents, type Package } from "@clavia/tardigrade-experimental-packages"
import type { ActorRuntime, Recorded, ActorDefinition, ActorOutput, EffectExecution, ActService } from "@clavia/tardigrade-experimental-core"
import { Actor, Promises, localActors, createActorStore, type ActorCaller } from "@clavia/tardigrade-experimental-host"
import { createActor } from "../agent"
import { budgetState } from "../atoms/durable/budget"
import { Event } from "../event"
import { ModelLock } from "./model-lock"
import { Model } from "./model"
import { turnOutput } from "../result"

export interface AssistantContext {
  readonly depth: number
  readonly parent: ActorCaller | undefined
}

type AgentActs = ActService<"agent.model.generate"> | ActService<"agent.model.summarize"> | ActService<"agent.tool.execute"> | ActService<"agent.permission.request">

type AssistantDefinition<Services> = ActorDefinition<Event, ActorOutput<unknown, Event, Services | AgentActs>, {
  readonly message: (input: { readonly text: string; readonly turnId?: string }) => Effect.Effect<void, Error>
}, ModelInfo | ToolCatalog>

export interface AssistantOptions<Services = never> {
  readonly actor?: AssistantDefinition<Services>
  readonly services: Layer.Layer<Model | ModelLock | Promises | PermissionRequests | Services, Error, Actor> | ((context: AssistantContext, host: ActorRuntime<Event>) => Layer.Layer<Model | ModelLock | Promises | PermissionRequests | Services, Error, Actor>)
  readonly packages?: readonly Package<Services | Actor | Workspace | Promises | EffectExecution>[]
  readonly maxChildDepth: number
  readonly onEvent?: (event: Recorded<Event>, depth: number) => void
}

// assistantServices supplies local child actors while the host chooses model and promise implementations.
export function assistantServices<Services>(host: ActorRuntime<Event>, options: AssistantOptions<Services>, depth: number, parent?: ActorCaller, budget?: typeof AgentBudget.Type): Layer.Layer<ModelInfo | ToolCatalog | AgentActs | Model | ModelLock | Promises | Actor | Workspace | Services, Error> {
  const children = localActors({
    run: (call, caller) => Effect.gen(function* () {
      if (depth >= options.maxChildDepth) return yield* Effect.fail(new RuntimeError(`Child depth limit reached: ${options.maxChildDepth}`))
      const childBudget = yield* Schema.decodeUnknownEffect(AgentBudget)(call.config?.budget ?? { toolCalls: DEFAULT_AGENT_TOOL_CALLS }).pipe(Effect.mapError(RuntimeError.from))
      return yield* Effect.acquireUseRelease(
        createActorStore({ actor: options.actor ?? createActor, ...assistantRuntime(options, depth + 1, caller, childBudget) }),
        child => Effect.gen(function* () {
          yield* child.message({ text: call.message, turnId: call.id })
          yield* child.wait
          const reply = child.snapshot().events.filter(Schema.is(Event)).findLast(event => event.type === "TurnSettled")
          if (!reply || reply.type !== "TurnSettled") return yield* Effect.fail(new RuntimeError("Child finished without an answer"))
          return { answer: turnOutput(child.snapshot().events.filter(Schema.is(Event)), reply) }
        }),
        child => child.close,

      )
    }),
    onRequest: (handle, request) => host.send([{ type: "MessageReceived", kind: "request", handle, request }]),
    onReply: (handle, requestId, decision) => host.record({ type: "MessageReceived", kind: "reply", handle, requestId, decision }),
    onMessage: (handle, message) => host.send([{ type: "MessageReceived", kind: "message", turnId: `${handle.id}:notice:${crypto.randomUUID()}`, text: JSON.stringify({ handle, message }) }]),
  })
  const services = typeof options.services === "function" ? options.services({ depth, parent }, host) : options.services
  const platform = Layer.mergeAll(services, memoryWorkspace, Layer.effectDiscard(budget ? host.onReady(Effect.suspend(() => host.record({
    type: host.get(budgetState).some(entry => entry.metric === "toolCalls") ? "BudgetUpdated" : "BudgetConfigured",
    metric: "toolCalls", policy: { limit: budget.toolCalls, scope: "turn", onExhausted: "deny" },
  }))) : Effect.void)).pipe(Layer.provideMerge(children))
  return Layer.mergeAll(modelInfo, modelActs, askPermission, toolActs(options.packages ?? [fetchPackage(), alarm(), workspace(), agents()])).pipe(Layer.provideMerge(platform))
}

// assistantRuntime configures services and observation for one level of child actors.
export function assistantRuntime<Services = never>(options: AssistantOptions<Services>, depth = 0, parent?: ActorCaller, budget?: typeof AgentBudget.Type) {
  if (!Number.isSafeInteger(options.maxChildDepth) || options.maxChildDepth < 0) throw new RuntimeError("maxChildDepth must be a nonnegative integer")
  return {
    actorContext,
    services: (host: ActorRuntime<Event>) => assistantServices(host, options, depth, parent, budget),
    onEvent: (event: Recorded<Event>) => options.onEvent?.(event, depth),
  }
}
