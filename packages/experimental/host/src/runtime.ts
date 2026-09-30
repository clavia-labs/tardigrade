import { RuntimeError, createStore, createEventLog, createEventSource, atom, EventLog, EffectExecution, ExecutionResult, EffectRequested, EffectSettled, hasCoreEventType, effectKey, type Recorded, type Atom, type Journal, type ActorRuntime, type ActorSetup, type Requirements, type ActorDefinition } from "@clavia/tardigrade-experimental-core"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Cause, Schema, Option, Queue } from "effect"
import { Promises } from "./services/promises"
import { select } from "./stores/thread"

export type ActorServices<Definition> = Definition extends ActorDefinition<infer Event, infer State, infer _Methods, infer Services>
  ? (runtime: ActorRuntime<Event>) => Layer.Layer<Requirements<{ root: Atom<State> }> | Exclude<Services, Scope.Scope>, Error>
  : never

// createActorStore instantiates an actor definition and owns its services, journal commits, and execution lifetime.
export function createActorStore<Event extends object, State, Methods extends object, Services>(options: {
  readonly actor: ActorDefinition<Event, State, Methods, Services>
  readonly services: (runtime: ActorRuntime<Event>) => Layer.Layer<Requirements<{ root: Atom<State> }> | Exclude<Services, Scope.Scope>, Error>
  // actorContext selects setup capabilities explicitly; the execution context is supplied only to effect execution.
  readonly actorContext: (services: Context.Context<Requirements<{ root: Atom<NoInfer<State>> }> | Exclude<NoInfer<Services>, Scope.Scope>>) => Context.Context<Exclude<NoInfer<Services>, Scope.Scope>>
  readonly events?: readonly Recorded<Event>[]
  readonly journal?: Journal<Event>
  readonly onEvent?: (event: Recorded<Event>) => void
}) {
  return Effect.gen(function* () {
    let root!: Atom<State>
    let methods!: Methods
    const store = yield* createRuntime({
      ...options,
      setup: options.actor.setup.pipe(Effect.map(setup => {
        root = setup.root
        return { ...setup, actions: (emit: (event: Event) => Effect.Effect<void, Error>) => {
          methods = setup.actions(emit)
          return methods
        } }
      })),
    })
    const state = select(store, root)
    return { ...store, getState: state.get, subscribe: state.subscribe, methods }
  })
}

// createRuntime builds services and an atom graph within an isolated actor lifetime.
function createRuntime<Event extends object, const Atoms extends Readonly<Record<string, Atom<unknown>>>, Actions extends object, Services>(options: {
  readonly setup: Effect.Effect<ActorSetup<Event, Atoms, Actions>, Error, Services>
  readonly services: (runtime: ActorRuntime<Event>) => Layer.Layer<Requirements<Atoms> | Exclude<Services, Scope.Scope>, Error>
  readonly actorContext: (services: Context.Context<Requirements<Atoms> | Exclude<Services, Scope.Scope>>) => Context.Context<Exclude<Services, Scope.Scope>>
  readonly events?: readonly Recorded<Event>[]
  readonly journal?: Journal<Event>
  readonly onEvent?: (event: Recorded<Event>) => void
}) {
  return Effect.gen(function* () {
    if (options.journal && options.events !== undefined) return yield* Effect.fail(new RuntimeError("Supply either a journal or initial events"))
    let setup: ActorSetup<Event, Atoms, Actions>
    let definition: ReturnType<typeof createEventLog<Event, Atoms>>
    let snapshot: ReturnType<typeof definition.replay>
    const source = createEventSource<Recorded<Event>>()
    const bindings = atom<ReadonlyMap<object, import("@clavia/tardigrade-experimental-core").EffectRef>>(new Map())
    const store = createStore(Context.make(EventLog, { events: source.events, bindings }))
    const sync = () => {
      const position = store.get(source.events).length
      if (position > snapshot.events.length) throw new RuntimeError("Committed event history cannot shrink")
      store.set(bindings, snapshot.bindings)
      source.append(store, snapshot.events.slice(position))
    }
    const recovery: Effect.Effect<void, Error>[] = []
    const committed: Effect.Effect<void, Error>[] = []
    const ready = Deferred.makeUnsafe<void>()
    const scope = yield* Scope.make()
    const background = new Map<string, Fiber.Fiber<void, never>>()
    const errors: Error[] = []
    const subscriptions = new Set<() => void>()
    let closed = false
    let persistenceFailure: RuntimeError | undefined
    const admissions = yield* Queue.make<Effect.Effect<void>>()
    const processing = yield* Queue.make<Deferred.Deferred<void>>()
    const notifications = yield* Queue.make<readonly Recorded<Event>[]>()
    let scheduled: Deferred.Deferred<void> | undefined
    const report = (error: unknown) => { if (!closed) errors.push(RuntimeError.from(error)) }
    const reportCause = (cause: Cause.Cause<unknown>) => Effect.sync(() => {
      if (!Cause.hasInterruptsOnly(cause)) report(new RuntimeError(Cause.pretty(cause)))
    })
    const schedule = Effect.gen(function* () {
      if (closed) return
      const completion = yield* Deferred.make<void>()
      scheduled = completion
      yield* Queue.offer(processing, completion)
    })
    const commit = (next: typeof snapshot) => Effect.gen(function* () {
      if (persistenceFailure) return yield* Effect.fail(persistenceFailure)
      if (next === snapshot) return
      const records = next.events.slice(snapshot.events.length)
      if (options.journal) yield* options.journal.append(snapshot.events.length, records).pipe(Effect.catchCause(cause => {
        definition.discard(next)
        persistenceFailure = new RuntimeError("Journal commit failed; reopen the actor before continuing", { cause })
        return Effect.fail(persistenceFailure)
      }))
      snapshot = next
      yield* Effect.try({ try: sync, catch: RuntimeError.from }).pipe(Effect.catch(error => Effect.sync(() => report(error))))
      yield* Queue.offer(notifications, records)
      yield* schedule
    })
    const enqueue = <Value>(work: Effect.Effect<Value, Error>) => Effect.gen(function* () {
      if (closed) return yield* Effect.fail(new RuntimeError("Actor store is closed"))
      const accepted = yield* Deferred.make<Value, Error>()
      yield* Queue.offer(admissions, Effect.gen(function* () {
        const outcome = yield* Effect.exit(work)
        yield* Deferred.done(accepted, outcome)
      }).pipe(Effect.uninterruptible))
      return yield* Deferred.await(accepted)
    })
    const appendNow = (event: Recorded<Event>) => Effect.gen(function* () {
      const updated = yield* Effect.try({ try: () => {
        let next = definition.append(snapshot, event)
        if (next === snapshot) return next
        try {
          for (const domain of next.followups(event)) {
            if (hasCoreEventType(domain)) throw new RuntimeError("Act callbacks must return domain events")
            next = definition.append(next, domain as Event)
          }
          return next
        } catch (error) {
          definition.discard(next)
          throw error
        }
      }, catch: RuntimeError.from })
      yield* commit(updated)
    })
    const append = (event: Recorded<Event>) => enqueue(appendNow(event))
    let services: Effect.Success<ReturnType<typeof buildServices>>
    function buildServices() {
      return Layer.build(options.services(runtime)).pipe(Effect.provideService(Scope.Scope, scope))
    }
    const dispatched = new Set<string>()
    const watched = new Set<string>()
    const observePromises = Effect.gen(function* () {
      const observer = Context.getOption(services, Promises)
      for (const record of snapshot.events) {
        if (!Schema.is(EffectSettled)(record) || record.outcome.status !== "fulfilled") continue
        const result = yield* Schema.decodeUnknownEffect(ExecutionResult)(record.outcome.value).pipe(Effect.mapError(RuntimeError.from))
        if (result.type !== "promise" || result.handle.executor === "local" || snapshot.promise(record.ref)) continue
        const key = effectKey(record.ref)
        if (watched.has(key)) continue
        if (Option.isNone(observer)) return yield* Effect.fail(new RuntimeError("Promise execution results require a Promises service"))
        yield* observer.value.watch({ ref: record.ref, handle: result.handle })
        watched.add(key)
      }
    })
    const afterCommit = () => Effect.gen(function* () {
      while (true) {
        const batch = yield* Queue.poll(notifications)
        if (Option.isNone(batch)) break
        for (const record of batch.value) {
          yield* Effect.try({ try: () => options.onEvent?.(record), catch: RuntimeError.from }).pipe(
            Effect.catch(error => Effect.sync(() => report(error))),
          )
        }
        for (const work of committed) yield* work.pipe(Effect.catchCause(reportCause))
      }
      yield* observePromises.pipe(Effect.catchCause(reportCause))
    })
    const drain = () => Effect.gen(function* () {
      while (true) {
        yield* afterCommit()
        const next = yield* enqueue(Effect.gen(function* () {
          if (closed) return
          if (persistenceFailure) return yield* Effect.fail(persistenceFailure)
          const delivery = yield* Effect.try({ try: () => snapshot.deliveries()[0], catch: RuntimeError.from })
          if (delivery) {
            yield* appendNow(delivery)
            return { kind: "delivery" as const }
          }
          const work = yield* Effect.try({ try: () => snapshot.effects().find(work => !dispatched.has(effectKey(work.ref))), catch: RuntimeError.from })
          if (!work) return
          if (!snapshot.effect(work.ref)) {
            const request = yield* Schema.decodeEffect(EffectRequested)({ type: "EffectRequested", ref: work.ref, request: work.request }).pipe(Effect.mapError(RuntimeError.from))
            yield* appendNow(request)
          }
          dispatched.add(effectKey(work.ref))
          return { kind: "work" as const, work }
        }))
        if (!next) return
        if (next.kind === "delivery") continue
        const { work } = next
        yield* afterCommit()
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
        const outcome = yield* work.execute.pipe(
          Effect.provideService(EffectExecution, execution),
          Effect.provide(services),
          Effect.flatMap(result => Schema.decodeEffect(ExecutionResult)(result).pipe(Effect.mapError(String))),
          Effect.map(value => ({ status: "fulfilled" as const, value })),
          Effect.catch(reason => Effect.succeed({ status: "rejected" as const, reason })),
        )
        const settlement = yield* Schema.decodeEffect(Schema.toType(EffectSettled))({ type: "EffectSettled", ref: work.ref, outcome }).pipe(Effect.mapError(RuntimeError.from))
        yield* append(settlement)
        dispatched.delete(effectKey(work.ref))
      }
    })
    const send = (events: readonly Recorded<Event>[], when?: (get: ActorRuntime<Event>["get"]) => boolean) => Effect.gen(function* () {
      yield* Deferred.await(ready)
      yield* enqueue(Effect.gen(function* () {
        if (persistenceFailure) return yield* Effect.fail(persistenceFailure)
        if (when && !(yield* Effect.try({ try: () => when(store.get), catch: RuntimeError.from }))) return
        for (const event of events) {
          if (!hasCoreEventType(event)) yield* Effect.try({ try: () => setup.validate?.(event as Event, store.get), catch: RuntimeError.from })
          yield* appendNow(event)
        }
        yield* schedule
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
      record: append,
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
    const run = (effect: Effect.Effect<void, Error>) => Effect.suspend(() =>
      closed ? Effect.fail(new RuntimeError("Actor store is closed")) : Effect.acquireUseRelease(effect.pipe(Effect.forkIn(scope)), Fiber.join, Fiber.interrupt),
    )
    const closing = yield* Effect.cached(Effect.gen(function* () {
      closed = true
      for (const unsubscribe of subscriptions) unsubscribe()
      subscriptions.clear()
      yield* Scope.close(scope, Exit.succeed(undefined)).pipe(Effect.ensuring(Effect.gen(function* () {
        yield* Queue.shutdown(admissions)
        yield* Queue.shutdown(processing)
        yield* Queue.shutdown(notifications)
        definition?.dispose()
        store.dispose()
      })))
    }).pipe(Effect.uninterruptible))
    const close = closing
    return yield* Effect.gen(function* () {
      yield* Effect.gen(function* () {
        while (true) yield* (yield* Queue.take(admissions))
      }).pipe(Effect.forkIn(scope))
      services = yield* buildServices()
      setup = yield* options.setup.pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(options.actorContext(services)))
      definition = createEventLog({ schema: setup.schema, atoms: setup.effects })
      const history = options.journal ? yield* options.journal.read : options.events ?? []
      snapshot = yield* Effect.try({ try: () => definition.replay(history), catch: RuntimeError.from })
      yield* Effect.try({ try: sync, catch: RuntimeError.from })
      yield* Deferred.succeed(ready, undefined)
      for (const recover of recovery) yield* recover
      yield* Effect.gen(function* () {
        while (true) {
          const completions = yield* Queue.takeAll(processing)
          yield* drain().pipe(Effect.catchCause(reportCause))
          for (const completion of completions) yield* Deferred.succeed(completion, undefined)
        }
      }).pipe(Effect.forkIn(scope))
      yield* schedule
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
        resume: run(send([])),
        replay: definition.replay,
        active: () => [...background.keys()],
        // wait observes local processing and failures; external promise delivery can arrive after it returns.
        wait: run(Effect.gen(function* () {
          while (true) {
            const completion = scheduled
            if (completion) yield* Deferred.await(completion)
            yield* Fiber.awaitAll([...background.values()])
            if (completion === scheduled && background.size === 0) break
          }
          if (errors.length) return yield* Effect.fail(errors[0]!)
        })),
        close,
      }
      const actions = setup.actions(event => run(send([event])))
      for (const [name, action] of Object.entries(actions)) {
        if (name in api || typeof action !== "function") return yield* Effect.fail(new RuntimeError(`Invalid actor action: ${name}`))
      }
      return { ...api, ...actions }
    }).pipe(Effect.onError(() => close))
  })
}
