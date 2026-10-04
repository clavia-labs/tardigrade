import { isDeepStrictEqual } from "node:util"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Random, Schema, Scope, Semaphore } from "effect"
import { Actor, ActorRequest, ActorCall, type ActorCaller } from "../services/actor"
import { atom, type Atom } from "../atoms/atom"
import { InvalidMessage, type MessageMetadata, type MessageReceipt } from "../actor/message"
import { MethodFailed, MethodCancelled, type ActorMethods, type MethodInput, type MethodOutput, type MethodResult } from "../actor/method"
import { RuntimeError, type ExecutionHandle } from "./effects"
import type { ThreadCoordinate, ThreadCreated } from "../actor/thread"
import type { ActorDefinition } from "../actor/definition"
import type { ActorRuntime, Requirements } from "./contracts"
import { WatchdogTerminalError, type WatchdogTarget, type RecoveryState } from "../services/watchdog"
import type { ResolutionState } from "../services/promises"
import type { PromisePolicy } from "../services/promises"

import type { InitialState, StatefulAtom } from "../initialise"
import { prepareInitialState } from "./initialisation"
import { createActorStore, type DeliveryOptions } from "./execution"
import { createThreadStore } from "./stores/thread"
import type { ExecutionStream, ExecutionStreamPolicy } from "../services/execution-stream"
import { initializeThread, readThreadCreation, type ThreadJournal } from "../services/journal/thread"

// localActors retains child results for its scope; handles from another scope reject instead of restarting work.
export function localActors(options: {
  readonly run: (call: ActorCall, caller: ActorCaller) => Effect.Effect<Schema.Json, Error>
  readonly onRequest: (handle: ExecutionHandle, request: ActorRequest) => Effect.Effect<void, Error>
  readonly onReply: (handle: ExecutionHandle, requestId: string, result: Schema.Json) => Effect.Effect<void, Error>
  readonly onMessage: (handle: ExecutionHandle, message: Schema.Json) => Effect.Effect<void, Error>
}) {
  return Layer.effect(Actor, Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const endpoint = (yield* Effect.all(Array.from({ length: 4 }, () => Random.nextInt))).join(":")
    const entries = new Map<string, { call: ActorCall; result: ResolutionState; cancelled: boolean; fiber?: Fiber.Fiber<void, never> }>()
    const replies = new Map<string, Deferred.Deferred<Schema.Json, Error>>()
    const cancelled = new Set<string>()
    const key = (handle: ExecutionHandle, requestId: string) => JSON.stringify([handle.id, requestId])
    const lookup = (handle: ExecutionHandle) => handle.executor === "actor" && handle.endpoint === endpoint ? entries.get(handle.id) : undefined
    return {
      invoke: input => Effect.gen(function* () {
        const call = yield* Schema.decodeEffect(ActorCall)(input)
        const handle = { executor: "actor", id: call.id, endpoint }
        const previous = entries.get(call.id)
        if (previous) {
          if (!isDeepStrictEqual(previous.call, call)) return yield* Effect.fail(new RuntimeError("Actor call identity already used"))
          return handle
        }
        const entry: { call: ActorCall; result: ResolutionState; cancelled: boolean; fiber?: Fiber.Fiber<void, never> } = { call, result: cancelled.has(call.id) ? { status: "rejected", reason: "Actor call cancelled" } : { status: "pending" }, cancelled: cancelled.has(call.id) }
        entries.set(call.id, entry)
        if (entry.cancelled) return handle
        const caller: ActorCaller = {
          handle,
          cancelled: () => entry.cancelled,
          notify: message => options.onMessage(handle, message),
          request: request => Effect.gen(function* () {
            const value = yield* Schema.decodeEffect(ActorRequest)(request)
            const id = key(handle, value.requestId)
            if (replies.has(id)) return yield* Effect.fail(new RuntimeError("Actor request already pending"))
            const reply = Deferred.makeUnsafe<Schema.Json, Error>()
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
          Effect.map(exit => { if (entry.result.status === "pending") entry.result = Exit.isSuccess(exit) ? { status: "fulfilled", value: exit.value } : { status: "rejected", reason: Cause.prettyErrors(exit.cause).map(error => error.message).join("\n") } }),
          Effect.forkIn(scope),
        )
        return handle
      }),
      poll: handle => Effect.sync(() => lookup(handle)?.result ?? { status: "rejected" as const, reason: "Local actor handle is no longer available" }),
      cancel: handle => Effect.gen(function* () {
        if (handle.executor !== "actor") return yield* Effect.fail(new RuntimeError("Invalid actor handle"))
        if (handle.endpoint !== undefined && handle.endpoint !== endpoint) return
        const entry = entries.get(handle.id)
        if (!entry) { cancelled.add(handle.id); return }
        if (entry.result.status !== "pending") return
        entry.cancelled = true
        entry.result = { status: "rejected", reason: "Actor call cancelled" }
        if (entry.fiber) yield* Fiber.interrupt(entry.fiber)
      }),
      reply: (handle, requestId, result) => Effect.gen(function* () {
        if (!lookup(handle)) return yield* Effect.fail(new RuntimeError("Unknown actor handle"))
        const pending = replies.get(key(handle, requestId))
        if (!pending) return yield* Effect.fail(new RuntimeError("No matching pending actor request"))
        const value = yield* Schema.decodeEffect(Schema.Json)(result)
        yield* options.onReply(handle, requestId, value)
        yield* Deferred.succeed(pending, value)
      }),
    } satisfies typeof Actor.Service
  }))
}

export interface ManagedThread<State, Contracts extends ActorMethods<object>> {
  readonly execution: Pick<typeof ExecutionStream.Service, "stream" | "policy">
  readonly contracts: Contracts
  readonly get: <Value>(node: Atom<Value>) => Value
  readonly sub: <Value>(node: Atom<Value>, listener: () => void) => () => void
  readonly getState: () => State
  readonly recoveryState: () => RecoveryState
  readonly resume: Effect.Effect<void, Error>
  readonly recover: Effect.Effect<void, Error>
  readonly wait: Effect.Effect<void, Error>
  readonly close: Effect.Effect<void, Error>
  readonly receive: (body: Schema.Json, metadata: MessageMetadata) => Effect.Effect<MessageReceipt, Error>
}

export interface ActorStorage<Event extends object> {
  readonly thread: (coordinate: ThreadCoordinate) => ThreadJournal<Event>
}

export interface ActorExecutionOptions<Event extends object, Services, State, Contracts extends ActorMethods<Event> = ActorMethods<Event>> {
  readonly executionStream?: Partial<ExecutionStreamPolicy>
  readonly executionStreamBus?: typeof ExecutionStream.Service
  readonly effectInput?: { readonly digestMinBytes?: number }
  readonly promises?: Partial<PromisePolicy>
  readonly canDrive?: (target: WatchdogTarget) => Effect.Effect<boolean, Error>
  // initialStateAtoms supplies destination codecs for state accepted during thread creation.
  readonly initialStateAtoms?: readonly StatefulAtom[]
  readonly actor: ActorDefinition<Event, State, Services, Contracts>
  readonly storage: ActorStorage<Event>
  readonly services: (coordinate: ThreadCoordinate, runtime: ActorRuntime<Event>) => Layer.Layer<Requirements<{ root: Atom<State> }> | Exclude<Services, Scope.Scope>, Error>
  readonly from: MessageMetadata["from"]
  readonly delivery: (coordinate: ThreadCoordinate) => DeliveryOptions
  readonly actorContext: (services: Context.Context<Requirements<{ root: Atom<State> }> | Exclude<Services, Scope.Scope>>) => Context.Context<Exclude<Services, Scope.Scope>>
}

// createActorExecution retains addressed runtimes and serializes their durable invocation admission within the host lifetime.
export function createActorExecution<Event extends object, Services, State, Contracts extends ActorMethods<Event> = ActorMethods<Event>>(options: ActorExecutionOptions<Event, Services, State, Contracts> & {
  readonly run: <Value>(work: Effect.Effect<Value, Error>) => Effect.Effect<Value, Error>
}) {
  let closed = false
  const lifecycleLocks = new Map<string, Semaphore.Semaphore>()
  const serialize = <Value>(coordinate: ThreadCoordinate, work: Effect.Effect<Value, Error>) => Effect.suspend(() => {
    const key = identity(coordinate)
    let lock = lifecycleLocks.get(key)
    if (!lock) { lock = Semaphore.makeUnsafe(1); lifecycleLocks.set(key, lock) }
    return lock.withPermit(work)
  })
  const threads = new Map<string, Effect.Effect<ManagedThread<State, Contracts>, Error>>()
  const liveThreads = new Map<string, ManagedThread<State, Contracts>>()
  const journals = new Map<string, ThreadJournal<Event>>()
  const subscriptions = new Map<string, Set<{ bind: (thread: ManagedThread<State, Contracts>) => void; detach: () => void }>>()
  const current = (coordinate: ThreadCoordinate) => {
    const thread = liveThreads.get(identity(coordinate))
    if (!thread) throw new RuntimeError("Thread runtime is unavailable during recovery")
    return thread
  }
  const projection = (coordinate: ThreadCoordinate) => ({
    get: <Value>(node: Atom<Value>) => current(coordinate).get(node),
    sub: <Value>(node: Atom<Value>, listener: () => void) => {
      if (closed) throw new RuntimeError("Actor execution is closed")
      const key = identity(coordinate)
      let entries = subscriptions.get(key)
      if (!entries) { entries = new Set(); subscriptions.set(key, entries) }
      let stop: (() => void) | undefined
      const notify = () => { try { listener() } catch (error) { console.error("Subscription error:", error) } }
      const entry = {
        bind: (thread: ManagedThread<State, Contracts>) => { stop?.(); stop = thread.sub(node, notify); notify() },
        detach: () => { stop?.(); stop = undefined },
      }
      entries.add(entry)
      const thread = liveThreads.get(key)
      if (thread) entry.bind(thread)
      return () => { entry.detach(); entries.delete(entry); if (!entries.size) subscriptions.delete(key) }
    },
  })
  const identity = (coordinate: ThreadCoordinate) => JSON.stringify([coordinate.actor, coordinate.instance, coordinate.thread])
  const journalFor = (coordinate: ThreadCoordinate) => {
    const key = identity(coordinate)
    let journal = journals.get(key)
    if (!journal) { journal = options.storage.thread(coordinate); journals.set(key, journal) }
    return journal
  }
  const open = (coordinate: ThreadCoordinate): Effect.Effect<ManagedThread<State, Contracts>, Error> => serialize(coordinate, Effect.gen(function* () {
    if (closed) return yield* Effect.fail(new RuntimeError("Actor execution is closed"))
    const key = identity(coordinate)
    let pending = threads.get(key)
    if (!pending) {
      const journal = journalFor(coordinate)
      pending = yield* Effect.cached(readThreadCreation(journal, coordinate).pipe(Effect.andThen(createActorStore<Event, State, Services, Contracts>({
        ...(options.effectInput ? { effectInput: options.effectInput } : {}), actor: options.actor, actorContext: options.actorContext, journal, ...(options.executionStream ? { executionStream: options.executionStream } : {}), ...(options.executionStreamBus ? { executionStreamBus: options.executionStreamBus } : {}), ...(options.canDrive ? { canDrive: options.canDrive(coordinate) } : {}), ...(options.promises ? { promises: options.promises } : {}), delivery: options.delivery(coordinate), services: runtime => options.services(coordinate, runtime),
      })), Effect.onError(() => Effect.sync(() => { threads.delete(key) }))))
      threads.set(key, pending)
    }
    const thread = yield* pending
    if (closed) { yield* thread.close; return yield* Effect.fail(new RuntimeError("Actor execution is closed")) }
    if (threads.get(key) === pending && liveThreads.get(key) !== thread) {
      liveThreads.set(key, thread)
      for (const subscription of subscriptions.get(key) ?? []) subscription.bind(thread)
    }
    return thread
  }))
  const reference = (coordinate: ThreadCoordinate) => Effect.gen(function* () {
    const thread = yield* open(coordinate)
    const journal = journalFor(coordinate)
    const source = projection(coordinate)
    const invoke = <Name extends keyof Contracts & string>(method: Name, input: MethodInput<Contracts[Name]>, request: { readonly id: string }) => options.run(Effect.gen(function* () {
      const body = yield* Schema.decodeUnknownEffect(Schema.Json)({ method, input }).pipe(Effect.mapError(InvalidMessage.from))
      const current = yield* open(coordinate)
      return yield* current.receive(body, { id: request.id, from: options.from })
    }))
    const result = <Name extends keyof Contracts & string>(name: Name, id: string): Effect.Effect<MethodResult<MethodOutput<Contracts[Name]>>, Error> => options.run(Effect.gen(function* () {
      const thread = yield* open(coordinate)
      const record = yield* journal.readMessage(id)
      const invocation = record?.record.message?.invocation
      const method = thread.contracts[name]
      if (!method || invocation?.method !== name) return yield* Effect.fail(new InvalidMessage("Result requires a matching invocation"))
      const node = atom(get => current(coordinate).contracts[name]!.result(invocation.input, get, { id, ref: { method: name, id } }))
      const settled = yield* Deferred.make<MethodResult<Schema.Json>, Error>()
      const check = () => {
        try {
          const value = source.get(node)
          if (value !== undefined) Deferred.doneUnsafe(settled, Effect.succeed(value))
        } catch (error) { Deferred.doneUnsafe(settled, Effect.fail(RuntimeError.from(error))) }
      }
      const output = yield* Effect.acquireUseRelease(
        Effect.sync(() => { const stop = source.sub(node, check); check(); return stop }),
        () => Deferred.await(settled), stop => Effect.sync(stop),
      )
      return output as MethodResult<MethodOutput<Contracts[Name]>>
    }))
    const cancel = <Name extends keyof Contracts & string>(method: Name, id: string, reason: string) => options.run(open(coordinate).pipe(Effect.flatMap(thread => thread.receive(
      { method, cancel: { id, reason } }, { id: JSON.stringify(["cancel", method, id]), from: options.from },
    ))))
    // methodState reads a committed invocation without waiting for its result.
    const methodState = <Name extends keyof Contracts & string>(name: Name, id: string) => options.run(Effect.gen(function* () {
      const thread = yield* open(coordinate)
      const record = yield* journal.readMessage(id)
      const invocation = record?.record.message?.invocation
      const method = thread.contracts[name]
      if (!method || invocation?.method !== name) return yield* Effect.fail(new InvalidMessage("State requires a matching invocation"))
      return method.result(invocation.input, thread.get, { id, ref: { method: name, id } }) ?? { status: "pending" as const }
    }))
    type Client = { readonly [Name in keyof Contracts]: (input: MethodInput<Contracts[Name]>, request: { readonly id: string }) => Effect.Effect<MethodOutput<Contracts[Name]>, Error> }
    const methods = Object.fromEntries(Object.keys(thread.contracts).map(name => [name, (input: Schema.Json, request: { readonly id: string }) => invoke(name, input, request).pipe(Effect.andThen(result(name, request.id)), Effect.flatMap(result => result.status === "completed" ? Effect.succeed(result.output) : Effect.fail(result.status === "failed" ? new MethodFailed(result.error) : new MethodCancelled(result.reason))))])) as Client
    return { coordinate: Object.freeze({ ...coordinate }), execution: thread.execution, store: createThreadStore(coordinate, source), contracts: thread.contracts, methods, invoke, result, cancel, methodState,
      records: () => options.run(journal.read),
      get: source.get, getState: () => current(coordinate).getState(), resume: options.run(open(coordinate).pipe(Effect.flatMap(thread => thread.resume))), wait: options.run(open(coordinate).pipe(Effect.flatMap(thread => thread.wait))),
      receipt: (id: string) => options.run(journal.readMessage(id).pipe(Effect.tap(record => record ? journal.acknowledge : Effect.void), Effect.map(record => record ? { id, position: record.position } : undefined))),
    }
  })
  return {
    open,
    probe: (coordinate: ThreadCoordinate) => Effect.try({ try: () => liveThreads.get(identity(coordinate))?.recoveryState(), catch: error => error instanceof WatchdogTerminalError ? error : RuntimeError.from(error) }),
    invalidate: (coordinate: ThreadCoordinate) => serialize(coordinate, Effect.gen(function* () {
      const key = identity(coordinate)
      const pending = threads.get(key)
      threads.delete(key)
      liveThreads.delete(key)
      for (const subscription of subscriptions.get(key) ?? []) subscription.detach()
      if (pending) yield* pending.pipe(Effect.flatMap(thread => thread.close), Effect.ignore)
    })),
    provision: (created: ThreadCreated, initialState?: InitialState) => Effect.gen(function* () {
      const seeded = initialState === undefined ? undefined : yield* prepareInitialState(options.initialStateAtoms ?? [], initialState)
      yield* initializeThread(journalFor(created.address), created, seeded)
      yield* open(created.address)
    }).pipe(Effect.asVoid),
    reference,
    receive: (coordinate: ThreadCoordinate, body: Schema.Json, metadata: MessageMetadata) => open(coordinate).pipe(Effect.flatMap(thread => thread.receive(body, metadata))),
    close: Effect.gen(function* () {
      closed = true
      liveThreads.clear()
      for (const entries of subscriptions.values()) for (const subscription of entries) subscription.detach()
      subscriptions.clear()
      const results = yield* Effect.forEach(threads.values(), pending =>
        Effect.exit(Effect.gen(function* () { const thread = yield* pending; yield* thread.close })),
      )
      const failure = results.find(Exit.isFailure)
      if (failure && Exit.isFailure(failure)) return yield* Effect.failCause(failure.cause)
    }),
  }
}
