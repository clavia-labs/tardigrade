import { isDeepStrictEqual } from "node:util"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Random, Schema, Scope } from "effect"
import { ExecutionHandle, RuntimeError } from "@clavia/tardigrade-experimental-core"
import type { ResolutionState } from "./promises"

export const ActorDecision = Schema.Union([
  Schema.Struct({ allowed: Schema.Literal(true), amount: Schema.optionalKey(Schema.Finite) }),
  Schema.Struct({ allowed: Schema.Literal(false), reason: Schema.String }),
])
export type ActorDecision = typeof ActorDecision.Type
export const ActorRequest = Schema.Struct({ requestId: Schema.NonEmptyString, kind: Schema.Literals(["permission", "budget"]), description: Schema.String, input: Schema.Json })
export type ActorRequest = typeof ActorRequest.Type
export const ActorCall = Schema.Struct({ id: Schema.NonEmptyString, message: Schema.String })
export type ActorCall = typeof ActorCall.Type

export interface ActorCaller {
  readonly handle: ExecutionHandle
  readonly notify: (message: Schema.Json) => Effect.Effect<void, Error>
  readonly request: (request: ActorRequest) => Effect.Effect<ActorDecision, Error>
}

// Actor submits child calls and addresses their results, cancellation, and request replies through execution handles.
export class Actor extends Context.Service<Actor, {
  readonly submit: (call: ActorCall) => Effect.Effect<ExecutionHandle, Error>
  readonly poll: (handle: ExecutionHandle) => Effect.Effect<ResolutionState, Error>
  readonly cancel: (handle: ExecutionHandle) => Effect.Effect<void, Error>
  readonly reply: (handle: ExecutionHandle, requestId: string, decision: ActorDecision) => Effect.Effect<void, Error>
}>()("experimental/host/Actor") {}

// localActors retains child results for its scope; handles from another scope reject instead of restarting work.
export function localActors(options: {
  readonly run: (call: ActorCall, caller: ActorCaller) => Effect.Effect<Schema.Json, Error>
  readonly onRequest: (handle: ExecutionHandle, request: ActorRequest) => Effect.Effect<void, Error>
  readonly onReply: (handle: ExecutionHandle, requestId: string, decision: ActorDecision) => Effect.Effect<void, Error>
  readonly onMessage: (handle: ExecutionHandle, message: Schema.Json) => Effect.Effect<void, Error>
}) {
  return Layer.effect(Actor, Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const endpoint = (yield* Effect.all(Array.from({ length: 4 }, () => Random.nextInt))).join(":")
    const entries = new Map<string, { call: ActorCall; result: ResolutionState; fiber?: Fiber.Fiber<void, never> }>()
    const replies = new Map<string, Deferred.Deferred<ActorDecision, Error>>()
    const key = (handle: ExecutionHandle, requestId: string) => JSON.stringify([handle.id, requestId])
    const lookup = (handle: ExecutionHandle) => handle.executor === "actor" && handle.endpoint === endpoint ? entries.get(handle.id) : undefined
    return {
      submit: input => Effect.gen(function* () {
        const call = yield* Schema.decodeEffect(ActorCall)(input)
        const handle = { executor: "actor", id: call.id, endpoint }
        const previous = entries.get(call.id)
        if (previous) {
          if (!isDeepStrictEqual(previous.call, call)) return yield* Effect.fail(new RuntimeError("Actor call identity already used"))
          return handle
        }
        const entry: { call: ActorCall; result: ResolutionState; fiber?: Fiber.Fiber<void, never> } = { call, result: { status: "pending" } }
        entries.set(call.id, entry)
        const caller: ActorCaller = {
          handle,
          notify: message => options.onMessage(handle, message),
          request: request => Effect.gen(function* () {
            const value = yield* Schema.decodeEffect(ActorRequest)(request)
            const id = key(handle, value.requestId)
            if (replies.has(id)) return yield* Effect.fail(new RuntimeError("Actor request already pending"))
            const reply = Deferred.makeUnsafe<ActorDecision, Error>()
            replies.set(id, reply)
            return yield* options.onRequest(handle, value).pipe(
              Effect.andThen(Deferred.await(reply)),
              Effect.ensuring(Effect.sync(() => { replies.delete(id) })),
            )
          }),
        }
        entry.fiber = yield* options.run(call, caller).pipe(
          Effect.flatMap(value => Schema.decodeEffect(Schema.Json)(value)),
          Effect.exit,
          Effect.map(exit => { entry.result = Exit.isSuccess(exit) ? { status: "fulfilled", value: exit.value } : { status: "rejected", error: Cause.prettyErrors(exit.cause).map(error => error.message).join("\n") } }),
          Effect.forkIn(scope),
        )
        return handle
      }),
      poll: handle => Effect.sync(() => lookup(handle)?.result ?? { status: "rejected" as const, error: "Local actor handle is no longer available" }),
      cancel: handle => Effect.gen(function* () {
        const entry = lookup(handle)
        if (!entry) return yield* Effect.fail(new RuntimeError("Unknown actor handle"))
        if (entry.result.status !== "pending") return
        if (entry.fiber) yield* Fiber.interrupt(entry.fiber)
        entry.result = { status: "rejected", error: "Actor call cancelled" }
      }),
      reply: (handle, requestId, decision) => Effect.gen(function* () {
        if (!lookup(handle)) return yield* Effect.fail(new RuntimeError("Unknown actor handle"))
        const pending = replies.get(key(handle, requestId))
        if (!pending) return yield* Effect.fail(new RuntimeError("No matching pending actor request"))
        const value = yield* Schema.decodeEffect(ActorDecision)(decision)
        yield* options.onReply(handle, requestId, value)
        yield* Deferred.succeed(pending, value)
      }),
    } satisfies typeof Actor.Service
  }))
}
