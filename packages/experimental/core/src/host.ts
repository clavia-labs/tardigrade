import { RuntimeError } from "./errors"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope, Semaphore, Cause } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { createStore } from "./store"
import { createEventLog } from "./event-log"
import { atom, type Atom } from "./atom"
import { EventLog } from "./durable"
import { recordEffect, type Recorded, type Proposed, type ServicesOf } from "./internal/effects"
import type { Journal } from "./journal"
import { EffectExecution } from "./effects"
import { effectKey } from "./internal/effects"

export type Requirements<Atoms> = Exclude<ServicesOf<Proposed<Atoms[keyof Atoms] extends Atom<infer Value> ? Value : never>>, EffectExecution>

export interface ActorRuntime<Event extends object> {
  readonly ready: Effect.Effect<void>
  // onReady registers recovery during service construction, after replay and before the store opens.
  readonly onReady: (recover: Effect.Effect<void, Error>) => Effect.Effect<void>
  // onCommit registers host work acknowledged after each journal commit.
  readonly onCommit: (work: Effect.Effect<void, Error>) => Effect.Effect<void>
  readonly get: <Value>(node: Atom<Value>) => Value
  readonly sub: <Value>(node: Atom<Value>, listener: () => void) => () => void
  readonly record: (event: Recorded<Event>) => Effect.Effect<void, Error>
  readonly send: (events: readonly Event[], when?: (get: ActorRuntime<Event>["get"]) => boolean) => Effect.Effect<void, Error>
  readonly fork: (id: string, work: Effect.Effect<void, Error>) => Effect.Effect<void, Error>
  readonly cancel: (id: string) => Effect.Effect<void, Error>
}

export interface ActorSetup<Event extends object, Atoms extends Readonly<Record<string, Atom<unknown>>>, Actions extends object> {
  readonly schema: Schema.Schema<Event>
  readonly effects: Atoms
  readonly actions: (emit: (event: Event) => Promise<void>) => Actions
  readonly validate?: (event: Event, get: ActorRuntime<Event>["get"]) => void
}

// createActorStore builds services and an atom graph within an isolated actor lifetime.
export async function createActorStore<Event extends object, const Atoms extends Readonly<Record<string, Atom<unknown>>>, Actions extends object, Services>(options: {
  readonly setup: Effect.Effect<ActorSetup<Event, Atoms, Actions>, Error, Services>
  readonly services: (runtime: ActorRuntime<Event>) => Layer.Layer<Requirements<Atoms> | Exclude<Services, Scope.Scope>, Error>
  readonly events?: readonly Recorded<Event>[]
  readonly journal?: Journal<Event>
  readonly onEvent?: (event: Recorded<Event>) => void
}) {
  if (options.journal && options.events !== undefined) throw new RuntimeError("Supply either a journal or initial events")
  let setup: ActorSetup<Event, Atoms, Actions>
  let definition: ReturnType<typeof createEventLog<Event, Atoms>>
  let snapshot: ReturnType<typeof definition.replay>
  const source = atom<readonly unknown[]>([]).pipe(NativeAtom.withLabel("events"))
  const store = createStore(Context.make(EventLog, { events: source }))
  let syncedEvents: readonly unknown[] = []
  const sync = () => {
    syncedEvents = [...syncedEvents, ...snapshot.events.slice(syncedEvents.length).map(record => {
      const { effect: _effect, ...event } = record
      return event
    })]
    store.set(source, syncedEvents)
  }
  const recovery: Effect.Effect<void, Error>[] = []
  const committed: Effect.Effect<void, Error>[] = []
  const lifecycle = new AbortController()
  const ready = Deferred.makeUnsafe<void>()
  const scope = Scope.makeUnsafe()
  const lock = Semaphore.makeUnsafe(1)
  const background = new Map<string, Fiber.Fiber<void, never>>()
  const errors: Error[] = []
  const pending = new Map<Promise<void>, AbortController>()
  const subscriptions = new Set<() => void>()
  let closed = false
  let closePromise: Promise<void> | undefined
  let persistenceFailure: Error | undefined
  const commit = async (next: typeof snapshot) => {
    if (persistenceFailure) throw persistenceFailure
    if (next === snapshot) return
    const records = next.events.slice(snapshot.events.length)
    try { await options.journal?.append(snapshot.events.length, records) } catch (error) {
      persistenceFailure = new RuntimeError("Journal commit failed; reopen the actor before continuing", { cause: error })
      throw persistenceFailure
    }
    snapshot = next
    sync()
    for (const record of records) options.onEvent?.(record)
    for (const work of committed) await Effect.runPromise(work, { signal: lifecycle.signal })
  }
  const append = (event: Recorded<Event>) => commit(definition.append(snapshot, event))
  let services: Awaited<ReturnType<typeof buildServices>>
  function buildServices() {
    return Effect.runPromise(Layer.build(options.services(runtime)).pipe(Effect.provideService(Scope.Scope, scope)))
  }
  const drain = () => Effect.gen(function* () {
    while (true) {
      const work = snapshot.effects()[0]
      if (!work) return
      if (work.request !== undefined) yield* Effect.tryPromise({ try: () => append(recordEffect(work.request!, work.ref, "requested")), catch: RuntimeError.from })
      const execution: typeof EffectExecution.Service = {
        ref: work.ref,
        get: store.get,
        record: event => runtime.record(event as unknown as Recorded<Event>),
        fork: operation => Effect.gen(function* () {
          const context = yield* Effect.context<Effect.Services<typeof operation>>()
          const id = effectKey(work.ref)
          yield* runtime.fork(id, operation.pipe(
            Effect.provide(context),
            Effect.flatMap(result => runtime.send((Array.isArray(result) ? result : [result]) as readonly Event[])),
          ))
          return { executor: "local" as const, id }
        }),
      }
      const result = yield* work.run.pipe(Effect.provideService(EffectExecution, execution), Effect.provide(services), Effect.mapError(RuntimeError.from))
      const results: readonly Recorded<Event>[] = Array.isArray(result) ? result : [result as Recorded<Event>]
      if (!results.length) return yield* Effect.fail(new RuntimeError("Effect settlement must contain an event"))
      const records = results.map((event, index) => index === results.length - 1 ? recordEffect(event, work.ref, "settled") : event)
      const next = definition.replay([...snapshot.events, ...records])
      yield* Effect.tryPromise({ try: () => commit(next), catch: RuntimeError.from })
    }
  })
  const send = (events: readonly Event[], when?: (get: ActorRuntime<Event>["get"]) => boolean) => Effect.gen(function* () {
    yield* Deferred.await(ready)
    yield* lock.withPermit(Effect.gen(function* () {
      if (closed) return yield* Effect.fail(new RuntimeError("Actor store is closed"))
      if (persistenceFailure) return yield* Effect.fail(persistenceFailure)
      if (when && !when(store.get)) return
      for (const event of events) {
        yield* Effect.tryPromise({ try: async () => { setup.validate?.(event, store.get); await append(event) }, catch: RuntimeError.from })
      }
      yield* drain()
    }))
  })
  const runtime: ActorRuntime<Event> = {
    ready: Deferred.await(ready),
    onReady: recover => Effect.sync(() => {
      if (setup !== undefined) throw new RuntimeError("Recovery must be registered during service construction")
      recovery.push(recover)
    }),
    onCommit: work => Effect.sync(() => {
      if (setup !== undefined) throw new RuntimeError("Commit hooks must be registered during service construction")
      committed.push(work)
    }),
    get: store.get,
    sub: store.sub,
    record: event => Effect.tryPromise({ try: async () => {
      if (closed) throw new RuntimeError("Actor store is closed")
      await append(event)
    }, catch: RuntimeError.from }),
    send,
    fork: (id, work) => Effect.gen(function* () {
      if (closed || background.has(id)) return yield* Effect.fail(new RuntimeError(`Cannot start background work: ${id}`))
      const fiber = yield* work.pipe(
        Effect.catchCause(cause => Effect.sync(() => { if (!closed && !Cause.hasInterruptsOnly(cause)) errors.push(new RuntimeError(Cause.pretty(cause))) })),
        Effect.ensuring(Effect.sync(() => { background.delete(id) })),
        Effect.forkIn(scope),
      )
      background.set(id, fiber)
    }),
    cancel: id => Effect.gen(function* () {
      const fiber = background.get(id)
      if (!fiber) return yield* Effect.fail(new RuntimeError(`No active background work: ${id}`))
      yield* Effect.forkIn(Fiber.interrupt(fiber), scope)
    }),
  }
  const run = (effect: Effect.Effect<void, Error>): Promise<void> => {
    if (closed) return Promise.reject(new RuntimeError("Actor store is closed"))
    const abort = new AbortController()
    const promise = Effect.runPromise(effect, { signal: abort.signal })
    pending.set(promise, abort)
    void promise.then(() => pending.delete(promise), () => pending.delete(promise))
    return promise
  }
  const close = () => closePromise ??= (async () => {
    closed = true
    lifecycle.abort()
    for (const unsubscribe of subscriptions) unsubscribe()
    subscriptions.clear()
    for (const abort of pending.values()) abort.abort()
    await Promise.allSettled(pending.keys())
    try { await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))) } finally { store.dispose() }
  })()
  try {
    services = await buildServices()
    setup = await Effect.runPromise(options.setup.pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(services)))
    definition = createEventLog({ schema: setup.schema, atoms: setup.effects })
    snapshot = definition.replay(options.journal ? await options.journal.read() : options.events ?? [])
    sync()
    Effect.runSync(Deferred.succeed(ready, undefined))
    for (const recover of recovery) await Effect.runPromise(recover, { signal: lifecycle.signal })
    const api = {
      get: store.get,
      sub: <Value>(node: Atom<Value>, listener: () => void) => {
        if (closed) throw new RuntimeError("Actor store is closed")
        const stop = store.sub(node, () => { try { listener() } catch (error) { console.error("Subscription error:", error) } })
        const unsubscribe = () => { stop(); subscriptions.delete(unsubscribe) }
        subscriptions.add(unsubscribe)
        return unsubscribe
      },
      snapshot: () => snapshot,
      resume: () => run(send([])),
      replay: definition.replay,
      active: () => [...background.keys()],
      wait: () => run(Effect.gen(function* () {
        while (background.size) yield* Fiber.awaitAll([...background.values()])
        if (errors.length) return yield* Effect.fail(errors[0]!)
      })),
      close,
    }
    const actions = setup.actions(event => run(send([event])))
    for (const [name, action] of Object.entries(actions)) {
      if (name in api || typeof action !== "function") throw new RuntimeError(`Invalid actor action: ${name}`)
    }
    return { ...api, ...actions }
  } catch (error) {
    await close()
    throw error
  }
}
