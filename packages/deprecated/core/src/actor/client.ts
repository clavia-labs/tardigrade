import { callableThread, type CallableThread } from "./target"
import { invocationTimeoutOf } from "../interaction/prepare"
import { Effect, Schema } from "effect"
import { allocateRootThread, allocateChildThread, ThreadAllocator, type ThreadAllocation, type RootThreadOptions, type ChildThreadOptions } from "./allocation"
import type { ActorDefinition } from "./definition"
import { ThreadCoordinate } from "./coordinate"
import type { ActorMethods, ActorMethodInput, ActorMethodOutput } from "./method"

export interface CallOptions {
  readonly key: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export type ClientThread<Methods extends ActorMethods> = CallableThread<Methods, { readonly [Name in keyof Methods]: (input: ActorMethodInput<Methods[Name]>, options: CallOptions) => Promise<ActorMethodOutput<Methods[Name]>> }>

export interface ActorClient<Methods extends ActorMethods> {
  readonly allocateRootThread: (options: RootThreadOptions) => Promise<ClientThread<Methods>>
  readonly allocateChildThread: (options: ChildThreadOptions) => Promise<ClientThread<Methods>>
  readonly thread: (coordinate: ThreadCoordinate) => ClientThread<Methods>
}

export interface ActorClientTransport {
  readonly allocate: (request: ThreadAllocation) => Promise<ThreadCoordinate>
  readonly invoke: (coordinate: ThreadCoordinate, method: string, input: unknown, options: CallOptions) => Promise<unknown>
}

// actorClient binds typed Promise methods to an allocation and invocation transport.
export const actorClient = <Methods extends ActorMethods>(actor: Pick<ActorDefinition<Methods>, "name" | "methods">, transport: ActorClientTransport): ActorClient<Methods> => {
  const thread = (value: ThreadCoordinate): ClientThread<Methods> => {
    const coordinate = Schema.decodeSync(ThreadCoordinate)(value)
    if (coordinate.actor !== actor.name || !coordinate.instance || !coordinate.thread) throw new Error("thread coordinate must identify a thread of this actor")
    return callableThread(coordinate, actor.methods, Object.fromEntries(Object.entries(actor.methods).map(([name, method]) => [name, async (input: unknown, options: CallOptions) => {
      Schema.decodeSync(Schema.NonEmptyString)(options.key)
      invocationTimeoutOf(method, options.timeoutMs)
      options.signal?.throwIfAborted()
      const validated = Schema.decodeUnknownSync(method.input)(input)
      return Schema.decodeUnknownSync(method.output)(await transport.invoke(coordinate, name, validated, options))
    }]))) as ClientThread<Methods>
  }
  const allocator = { allocate: (request: ThreadAllocation) => Effect.promise(() => transport.allocate(request)) }
  return {
    thread,
    allocateRootThread: async (options) => thread((await Effect.runPromise(allocateRootThread(actor, options).pipe(Effect.provideService(ThreadAllocator, allocator)))).coordinate),
    allocateChildThread: async (options) => thread((await Effect.runPromise(allocateChildThread(actor, options).pipe(Effect.provideService(ThreadAllocator, allocator)))).coordinate)
  }
}
