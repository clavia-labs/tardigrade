import { Context, Effect, Schema } from "effect"
import { ExecutionHandle } from "../runtime/effects"
import type { PromiseState } from "../atoms/promise"
import { ThreadCoordinate } from "../actor/thread"

export const ActorRequest = Schema.Struct({ requestId: Schema.NonEmptyString, method: Schema.NonEmptyString, input: Schema.Json })
export type ActorRequest = typeof ActorRequest.Type
export const ActorCall = Schema.Struct({ id: Schema.NonEmptyString, target: ThreadCoordinate, method: Schema.NonEmptyString, input: Schema.Json })
export type ActorCall = typeof ActorCall.Type

export interface ActorCaller {
  readonly handle: ExecutionHandle
  readonly cancelled: () => boolean
  readonly notify: (message: Schema.Json) => Effect.Effect<void, Error>
  readonly request: (request: ActorRequest) => Effect.Effect<Schema.Json, Error>
}

// Actor invokes addressed methods and addresses their results, cancellation, and request replies through execution handles.
export class Actor extends Context.Service<Actor, {
  readonly invoke: (call: ActorCall) => Effect.Effect<ExecutionHandle, Error>
  readonly poll: (handle: ExecutionHandle) => Effect.Effect<PromiseState<Schema.Json, string>, Error>
  // cancel fences invocation by call identity when the handle has not yet been retained.
  readonly cancel: (handle: ExecutionHandle) => Effect.Effect<void, Error>
  readonly reply: (handle: ExecutionHandle, requestId: string, result: Schema.Json) => Effect.Effect<void, Error>
}>()("experimental/Actor") {}
