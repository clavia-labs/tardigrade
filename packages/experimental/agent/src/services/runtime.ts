import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { Effect, Layer, Schema } from "effect"
import { Workspace, memoryWorkspace, AgentBudget, DEFAULT_AGENT_TOOL_CALLS } from "@clavia/tardigrade-experimental-packages"
import type { ActorRuntime, Recorded, ActorDefinition, EffectOutput, EffectExecution } from "@clavia/tardigrade-experimental-core"
import { Actor, Promises, localActors, createActorStore, type ActorCaller } from "@clavia/tardigrade-experimental-host"
import { createActor } from "../agent"
import type { Event } from "../event"
import { ModelLock } from "./model-lock"
import { Model } from "./model"
import { promiseServices } from "./promises"
import { turnOutput } from "../result"

export interface AssistantContext {
  readonly depth: number
  readonly parent: ActorCaller | undefined
}

type AssistantDefinition<Services> = ActorDefinition<Event, EffectOutput<unknown, Event, Error, Services | Model | ModelLock | Actor | Workspace | Promises | EffectExecution>, {
  readonly message: (input: { readonly text: string; readonly turnId?: string }) => Promise<void>
}, Services | ModelLock | Actor | Workspace | Promises>

export interface AssistantOptions<Services = never> {
  readonly actor?: AssistantDefinition<Services>
  readonly services: Layer.Layer<Model | ModelLock | Promises | Services, Error, Actor> | ((context: AssistantContext, host: ActorRuntime<Event>) => Layer.Layer<Model | ModelLock | Promises | Services, Error, Actor>)
  readonly maxChildDepth: number
  readonly onEvent?: (event: Recorded<Event>, depth: number) => void
}

// assistantServices supplies local child actors while the host chooses model and promise implementations.
export function assistantServices<Services>(host: ActorRuntime<Event>, options: AssistantOptions<Services>, depth: number, parent?: ActorCaller, budget?: typeof AgentBudget.Type): Layer.Layer<Model | ModelLock | Promises | Actor | Workspace | Services, Error> {
  const children = localActors({
    run: (call, caller) => Effect.gen(function* () {
      if (depth >= options.maxChildDepth) return yield* Effect.fail(new RuntimeError(`Child depth limit reached: ${options.maxChildDepth}`))
      const childBudget = yield* Schema.decodeUnknownEffect(AgentBudget)(call.config?.budget ?? { toolCalls: DEFAULT_AGENT_TOOL_CALLS }).pipe(Effect.mapError(RuntimeError.from))
      return yield* Effect.acquireUseRelease(
        Effect.tryPromise({ try: () => createActorStore({ actor: options.actor ?? createActor, ...assistantRuntime(options, depth + 1, caller, childBudget) }), catch: RuntimeError.from }),
        child => Effect.tryPromise({ try: async signal => {
          const stop = () => { void child.close() }
          signal.addEventListener("abort", stop, { once: true })
          try {
            await child.message({ text: call.message, turnId: call.id })
            await child.wait()
            const reply = child.snapshot().events.findLast(event => event.type === "TurnSettled")
            if (!reply || reply.type !== "TurnSettled") throw new RuntimeError("Child finished without an answer")
            return { answer: turnOutput(child.snapshot().events, reply) }
          } finally { signal.removeEventListener("abort", stop) }
        }, catch: RuntimeError.from }),
        child => Effect.promise(() => child.close()),
      )
    }),
    onRequest: (handle, request) => host.send([{ type: "MessageReceived", kind: "request", handle, request }]),
    onReply: (handle, requestId, decision) => host.record({ type: "MessageReceived", kind: "reply", handle, requestId, decision }),
    onMessage: (handle, message) => host.send([{ type: "MessageReceived", kind: "message", turnId: `${handle.id}:notice:${crypto.randomUUID()}`, text: JSON.stringify({ handle, message }) }]),
  })
  const services = typeof options.services === "function" ? options.services({ depth, parent }, host) : options.services
  return promiseServices(host).pipe(Layer.provideMerge(
    Layer.mergeAll(services, memoryWorkspace, Layer.effectDiscard(budget ? host.onReady(host.record({
      type: "BudgetConfigured", policy: { maxCalls: budget.toolCalls, scope: "turn", onExhausted: "deny" },
    })) : Effect.void)).pipe(Layer.provideMerge(children)),
  ))
}

// assistantRuntime configures services and observation for one level of child actors.
export function assistantRuntime<Services = never>(options: AssistantOptions<Services>, depth = 0, parent?: ActorCaller, budget?: typeof AgentBudget.Type) {
  if (!Number.isSafeInteger(options.maxChildDepth) || options.maxChildDepth < 0) throw new RuntimeError("maxChildDepth must be a nonnegative integer")
  return {
    services: (host: ActorRuntime<Event>) => assistantServices(host, options, depth, parent, budget),
    onEvent: (event: Recorded<Event>) => options.onEvent?.(event, depth),
  }
}
