import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { Effect, Layer } from "effect"
import { Workspace, memoryWorkspace } from "@clavia/tardigrade-experimental-packages"
import type { ActorRuntime, Recorded } from "@clavia/tardigrade-experimental-core"
import { Actor, Resolver, localActors, type ActorCaller } from "@clavia/tardigrade-experimental-host"
import { createActor } from "../agent"
import type { Event } from "../event"
import { ModelLock } from "./model-lock"
import { Model } from "./model"
import { resolverServices } from "./resolver"

export interface AssistantContext {
  readonly depth: number
  readonly parent: ActorCaller | undefined
}

export interface AssistantOptions {
  readonly services: Layer.Layer<Model | ModelLock | Resolver, Error, Actor> | ((context: AssistantContext, host: ActorRuntime<Event>) => Layer.Layer<Model | ModelLock | Resolver, Error, Actor>)
  readonly maxChildDepth: number
  readonly onEvent?: (event: Recorded<Event>, depth: number) => void
}

// assistantServices supplies local child actors while the host chooses model and resolver implementations.
export function assistantServices(host: ActorRuntime<Event>, options: AssistantOptions, depth: number, parent?: ActorCaller): Layer.Layer<Model | ModelLock | Resolver | Actor | Workspace, Error> {
  const children = localActors({
    run: (call, caller) => Effect.gen(function* () {
      if (depth >= options.maxChildDepth) return yield* Effect.fail(new RuntimeError(`Child depth limit reached: ${options.maxChildDepth}`))
      return yield* Effect.acquireUseRelease(
        Effect.tryPromise({ try: () => createActor(assistantRuntime(options, depth + 1, caller)), catch: RuntimeError.from }),
        child => Effect.tryPromise({ try: async signal => {
          const stop = () => { void child.close() }
          signal.addEventListener("abort", stop, { once: true })
          try {
            await child.message({ text: call.message, turnId: call.id })
            await child.wait()
            const reply = child.snapshot().events.findLast(event => event.type === "TurnSettled")
            if (!reply || reply.type !== "TurnSettled") throw new RuntimeError("Child finished without an answer")
            if (reply.outcome !== "completed") throw new RuntimeError(reply.reason)
            return { answer: reply.output }
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
  return resolverServices(host).pipe(Layer.provideMerge(
    Layer.merge(services, memoryWorkspace).pipe(Layer.provideMerge(children)),
  ))
}

// assistantRuntime configures services and observation for one level of child actors.
export function assistantRuntime(options: AssistantOptions, depth = 0, parent?: ActorCaller) {
  if (!Number.isSafeInteger(options.maxChildDepth) || options.maxChildDepth < 0) throw new RuntimeError("maxChildDepth must be a nonnegative integer")
  return {
    services: (host: ActorRuntime<Event>) => assistantServices(host, options, depth, parent),
    onEvent: (event: Recorded<Event>) => options.onEvent?.(event, depth),
  }
}
