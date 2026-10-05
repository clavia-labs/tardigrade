import { DurableObject } from "cloudflare:workers"
import { Context, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { isDeepStrictEqual } from "node:util"
import { createActorExecution, createActorStore, createSupervisor, createWatchdog, DEFAULT_EXTERNAL_SENDER, Invocation, RuntimeError, Supervisor, ThreadCoordinate, ThreadCreated, watchdogKey, type ActorMethods, type IncomingMessage, type InitialState, type MessageReceipt, type MessageDelivery, type ThreadRequest, type RecoveryState, type WatchdogTarget, type WatchdogPolicy, type Recorded, type StoredCheckpoint, type ActorExecutionOptions } from "@clavia/tardigrade-core"
import { createInvocation } from "@clavia/tardigrade-core/services/invocation"
import type { createThreadHost } from "@clavia/tardigrade-core/runtime/layers"
import { initializeThread } from "@clavia/tardigrade-core/services/journal/thread"
import { prepareInitialState } from "@clavia/tardigrade-core/runtime/initialisation"
import type { SupervisorEvent } from "@clavia/tardigrade-core/services/supervisor/graph"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { makeRetryingAlarms, type CloudflareAlarmOptions } from "@clavia/tardigrade-cloudflare/retry"
import { cloudflareWatchdogStorage, cloudflareWatchdogTransaction } from "./watchdog"
import { sqlJournal } from "../shared/sql-journal"
import { CLOUDFLARE_SQL_LIMITS, CLOUDFLARE_MAX_CHECKPOINT_CHUNK_BYTES } from "./limits"
import { DEFAULT_CHECKPOINT_CHUNK_BYTES, validateCheckpointChunkBytes } from "../shared/checkpoint-chunks"
import { methodHttp, DEFAULT_METHOD_HTTP_INSTANCE, type MethodHttpOptions } from "../shared/method-http"
import { HttpRouter } from "effect/unstable/http"
import { hostRoutes, publicError } from "../shared/http"

export const CLOUDFLARE_CHILD_PLACEMENTS = ["independent"] as const
export const DEFAULT_CLOUDFLARE_CHILD_PLACEMENT = "independent" as const

export interface ActorDirectoryStub {
  readonly allocate: (request: ThreadRequest) => Promise<ThreadCoordinate>
  readonly lookup: (coordinate: ThreadCoordinate) => Promise<ThreadCoordinate | undefined>
  readonly fetch: (request: Request) => Promise<Response>
}
export interface ThreadRuntimeStub {
  readonly provision: (created: ThreadCreated, initialState?: InitialState) => Promise<void>
  readonly receive: (packet: IncomingMessage) => Promise<MessageReceipt>
  readonly fetch: (request: Request) => Promise<Response>
}
export interface CloudflareObjectBindings {
  readonly ACTORS: { readonly getByName: (name: string) => ActorDirectoryStub }
  readonly THREADS: { readonly getByName: (name: string) => ThreadRuntimeStub }
}

type ExecutionOptions<Event extends object, Services, State, Contracts extends ActorMethods<Event>> = ActorExecutionOptions<Event, Services, State, Contracts>
export type ActorObjectOptions<Env extends object, Event extends object, Services, State, Contracts extends ActorMethods<Event>> = Omit<ExecutionOptions<Event, Services, State, Contracts>, "storage" | "services" | "from" | "delivery" | "actorContext" | "executionStreamBus"> & Pick<Parameters<typeof createThreadHost<Event, Services, State, Contracts>>[0], "from" | "delivery" | "transports" | "actorTransport" | "telemetry" | "defaultChildPlacement"> & {
  readonly actorContext?: ExecutionOptions<Event, Services, State, Contracts>["actorContext"]
  // services receives the current Durable Object storage for local cache layers.
  readonly services: (env: Env, ...args: [...Parameters<ExecutionOptions<Event, Services, State, Contracts>["services"]>, DurableObjectStorage]) => Layer.Layer<Layer.Success<ReturnType<ExecutionOptions<Event, Services, State, Contracts>["services"]>>, Error, Supervisor | Invocation>
  readonly alarms?: CloudflareAlarmOptions
  readonly watchdog?: { readonly policy?: Partial<WatchdogPolicy>; readonly retryable?: (error: Error) => boolean }
  readonly http?: (env: Env) => MethodHttpOptions
  readonly checkpointChunkBytes?: number
  readonly generateName?: () => string
}

// cloudflareThreadName identifies a thread DO by its complete coordinate (test/workerd/thread-layout.workers.ts).
export const cloudflareThreadName = (coordinate: ThreadCoordinate): string => JSON.stringify([coordinate.actor, coordinate.instance, coordinate.thread])

// objectJournal commits journal records and watchdog admission in the same storage transaction (test/workerd/watchdog.workers.ts).
export function objectJournal<Event extends object>(options: {
  readonly storage: DurableObjectStorage
  readonly key: string
  readonly checkpointChunkBytes?: number | undefined
  readonly target: WatchdogTarget
  readonly alarms?: CloudflareAlarmOptions | undefined
  readonly watchdog: ReturnType<typeof createWatchdog>
}) {
  const alarms = makeRetryingAlarms(options.storage, options.alarms)
  return sqlJournal<Event>({ actor: options.key, limits: CLOUDFLARE_SQL_LIMITS, checkpointChunkBytes: options.checkpointChunkBytes, layer: SqliteClient.layer({ storage: options.storage }), flush: alarms.sync,
    commit: (work, records, position) => Effect.gen(function* () {
      const context = yield* Effect.context<never>()
      yield* Effect.tryPromise({ try: () => options.storage.transaction(tx => Effect.runPromiseWith(context)(Effect.gen(function* () {
        yield* work
        if (!records.length) return
        let progressCursor = 0
        let admission = false
        for (const [index, record] of records.entries()) {
          const event: object = record.event
          if ("type" in event && (event.type === "EffectSettled" || event.type === "PromiseSettled")) progressCursor = position - records.length + index + 1
          if ("type" in event && (event.type === "MessageReceived" || event.type === "ThreadCreated" || event.type === "ThreadRequested")) admission = true
        }
        yield* options.watchdog.admit(cloudflareWatchdogTransaction(tx, options.alarms), options.target, progressCursor, admission)
      }))), catch: RuntimeError.from })
    }).pipe(Effect.uninterruptible),
  })
}

// objectResponse handles health checks and translates request failures to public HTTP errors.
async function objectResponse(request: Request, handle: () => Promise<Response>): Promise<Response> {
  if (new URL(request.url).pathname === "/healthz") return Response.json({ status: "resting", dirty: 0 })
  try { return await handle() }
  catch (error) {
    const response = publicError(error)
    await Effect.runPromise(Effect.logError("HTTP request failed", error))
    return Response.json(response.body, { status: response.status })
  }
}

// createActorObjects separates the instance directory from per-thread storage, execution, and alarms (test/workerd/thread-layout.workers.ts).
export function createActorObjects<Env extends object = Record<string, unknown>, Event extends object = object, Services = never, State = unknown, Contracts extends ActorMethods<Event> = ActorMethods<Event>>(options: ActorObjectOptions<Env, Event, Services, State, Contracts>) {
  validateCheckpointChunkBytes(options.checkpointChunkBytes ?? DEFAULT_CHECKPOINT_CHUNK_BYTES, CLOUDFLARE_MAX_CHECKPOINT_CHUNK_BYTES)
  const actorContext = options.actorContext ?? (() => Context.empty()) as unknown as ExecutionOptions<Event, Services, State, Contracts>["actorContext"]
  const io = <Value>(work: () => Promise<Value>) => Effect.tryPromise({ try: work, catch: RuntimeError.from })
  if (options.defaultChildPlacement !== undefined && options.defaultChildPlacement !== "independent") throw new RuntimeError("Cloudflare object hosts require independent placement")
  const receiptIo = (work: () => Promise<MessageReceipt>) => io(work).pipe(Effect.map(receipt => ({ id: receipt.id, ...(receipt.position === undefined ? {} : { position: receipt.position }) })))
  const coordinateIo = <Value extends ThreadCoordinate | undefined>(work: () => Promise<Value>) => io(work).pipe(Effect.map(value => value === undefined ? undefined : { actor: value.actor, instance: value.instance, thread: value.thread }))
  const validateCoordinate = Schema.decodeUnknownSync(ThreadCoordinate, { onExcessProperty: "error" })

  class ActorObject extends DurableObject<Env & CloudflareObjectBindings> {
    private instance: string | undefined
    private readonly identityReady = this.ctx.blockConcurrencyWhile(async () => { this.instance = await this.ctx.storage.get<string>("tardie:actor:instance") })
    private journal: ReturnType<typeof objectJournal<SupervisorEvent>> | undefined
    private directory: ReturnType<typeof createSupervisor> | undefined
    private scope = Scope.makeUnsafe()
    private readonly recovering = new Set<Fiber.Fiber<void, Error>>()
    private readonly watchdog = createWatchdog({ storage: cloudflareWatchdogStorage(this.ctx.storage, options.alarms), ...options.watchdog,
      recover: target => Effect.suspend(() => this.supervisor(target.instance).recover(target.instance)),
      invalidate: target => Effect.suspend(() => this.supervisor(target.instance).invalidate(target.instance)),
      launch: work => Effect.sync(() => {
        const fiber = Effect.runFork(work)
        this.recovering.add(fiber)
        fiber.addObserver(() => { this.recovering.delete(fiber) })
      }),
    })
    private telemetryContext: Context.Context<{}> | undefined
    private run = <Value>(work: Effect.Effect<Value, Error>) => Effect.suspend(() => {
      if (options.telemetry && !this.telemetryContext) this.telemetryContext = Effect.runSync(Layer.buildWithScope(options.telemetry, this.scope))
      const instrumented = this.telemetryContext ? Effect.provide(work, this.telemetryContext) : work
      return Effect.acquireUseRelease(instrumented.pipe(Effect.forkIn(this.scope)), Fiber.join, Fiber.interrupt)
    })

    private async init(instance: string) {
      await this.identityReady
      if (!instance || (this.ctx.id.name !== undefined && this.ctx.id.name !== instance)) throw new RuntimeError("Actor DO instance differs from its address")
      if (this.instance !== undefined && this.instance !== instance) throw new RuntimeError("Actor DO instance identity cannot change")
      if (this.instance === undefined) {
        await this.ctx.storage.put("tardie:actor:instance", instance)
        await this.ctx.storage.sync()
        this.instance = instance
      }
    }
    private supervisor(instance: string) {
      if (this.instance !== instance) throw new RuntimeError("Actor DO instance is not initialized")
      if (!this.directory) {
        this.journal = objectJournal({ storage: this.ctx.storage, key: JSON.stringify([options.actor.actorName, instance, "supervisor"]), checkpointChunkBytes: options.checkpointChunkBytes, target: { actor: options.actor.actorName, instance }, watchdog: this.watchdog, ...(options.alarms ? { alarms: options.alarms } : {}) })
        this.directory = createSupervisor({ actor: options.actor.actorName, journal: () => this.journal!, run: this.run,
          ...(options.checkpointPolicy ? { checkpointPolicy: options.checkpointPolicy } : {}),
          canDrive: () => this.watchdog.status.pipe(Effect.flatMap(entries => entries.get(watchdogKey({ actor: options.actor.actorName, instance }))?.status === "blocked" ? Effect.succeed(false) : options.canDrive ? options.canDrive({ actor: options.actor.actorName, instance }) : Effect.succeed(true))),
          defaultChildPlacement: DEFAULT_CLOUDFLARE_CHILD_PLACEMENT, supportedChildPlacements: CLOUDFLARE_CHILD_PLACEMENTS,
          ...(options.promises ? { promises: options.promises } : {}), ...(options.generateName ? { generateName: options.generateName } : {}),
          validateInitialState: state => prepareInitialState(options.initialStateAtoms ?? [], state).pipe(Effect.asVoid),
          provision: allocation => io(() => this.env.THREADS.getByName(cloudflareThreadName(allocation.coordinate)).provision({ type: "ThreadCreated", address: allocation.coordinate,
            parent: allocation.parent === null ? null : { ...allocation.coordinate, thread: allocation.parent }, depth: allocation.depth, placement: allocation.placement,
          }, allocation.initialState)),
        })
      }
      return this.directory
    }
    async allocate(request: ThreadRequest): Promise<ThreadCoordinate> {
      await this.init(request.instance)
      const coordinate = await Effect.runPromise(this.supervisor(request.instance).allocate(request))
      await this.lookup(coordinate)
      return coordinate
    }
    async lookup(input: ThreadCoordinate): Promise<ThreadCoordinate | undefined> {
      const coordinate = validateCoordinate(input)
      if (coordinate.actor !== options.actor.actorName) throw new RuntimeError("Actor definition differs from thread coordinate")
      await this.init(coordinate.instance)
      const directory = this.supervisor(coordinate.instance)
      const found = await Effect.runPromise(directory.lookup(coordinate))
      if (found) {
        const store = await Effect.runPromise(directory.store(coordinate.instance))
        const entry = store.threads.get().find(entry => entry.coordinate.thread === coordinate.thread)
        if (entry?.placement !== "independent") throw new RuntimeError("Stored colocated threads require migration before independent routing")
      }
      return found
    }
    private deliver = (message: MessageDelivery) => createInvocation({
      supervisor: {
        allocate: input => coordinateIo(() => this.env.ACTORS.getByName(input.instance).allocate(input)).pipe(Effect.map(value => value!)),
        lookup: coordinate => coordinateIo(() => this.env.ACTORS.getByName(coordinate.instance).lookup(coordinate)),
        store: () => Effect.fail(new RuntimeError("Supervisor projections are owned by the Actor DO")),
      },
      reference: coordinate => Effect.succeed(coordinate),
      receive: (target, body, message) => receiptIo(() => this.env.THREADS.getByName(cloudflareThreadName(target)).receive({ target, body, message })),
      from: options.from ?? DEFAULT_EXTERNAL_SENDER, run: this.run,
      ...(options.actorTransport ? { actorTransport: options.actorTransport } : {}), ...(options.transports ? { transports: options.transports } : {}),
    }).send(message)
    async fetch(request: Request): Promise<Response> {
      return objectResponse(request, () => this.handleRequest(request))
    }
    private async handleRequest(request: Request): Promise<Response> {
      const pathname = new URL(request.url).pathname
      const match = /^\/v1\/actors\/([^/]+)\/threads(?:\/([^/]+))?/.exec(pathname)
      const http = options.http?.(this.env) ?? {}
      const instance = match ? decodeURIComponent(match[1]!) : this.instance ?? this.ctx.id.name ?? http.instance ?? DEFAULT_METHOD_HTTP_INSTANCE
      if (http.token !== undefined && request.headers.get("authorization") !== `Bearer ${http.token}`) return Response.json({ code: "unauthorized", message: "Unauthorized" }, { status: 401 })
      await this.init(instance)
      if (match?.[2] !== undefined) {
        const coordinate = { actor: options.actor.actorName, instance, thread: decodeURIComponent(match[2]) }
        if (!await this.lookup(coordinate)) return Response.json({ code: "thread_not_found", message: "Unknown thread" }, { status: 404 })
        return this.env.THREADS.getByName(cloudflareThreadName(coordinate)).fetch(request)
      }
      const directory = this.supervisor(instance)
      const host = {
        actor: options.actor.actorName,
        methodContracts: () => Effect.acquireUseRelease(createActorStore({ actor: options.actor, actorContext, inspect: true,
          services: runtime => options.services(this.env, { actor: options.actor.actorName, instance, thread: "$methods" }, runtime, this.ctx.storage).pipe(Layer.provideMerge(Layer.merge(Layer.succeed(Supervisor, directory), Layer.succeed(Invocation, { send: this.deliver })))),
        }), store => Effect.succeed(store.contracts), store => store.close),
        allocateRootThread: (input: Omit<ThreadRequest, "parent">) => io(() => this.allocate(input)).pipe(Effect.map(coordinate => ({ coordinate }))),
        allocateChildThread: (input: Omit<ThreadRequest, "instance" | "parent"> & { readonly parent: ThreadCoordinate }) => io(() => this.allocate({ ...input, instance: input.parent.instance })).pipe(Effect.map(coordinate => ({ coordinate }))),
        getThread: () => Effect.fail(new RuntimeError("Thread requests must be forwarded to their owner")),
      }
      return methodHttp(host, http)(request)
    }
    async alarm() { await this.identityReady; if (this.instance !== undefined) { this.supervisor(this.instance); await Effect.runPromise(this.watchdog.alarm) } }
    async dispose() { return this.ctx.blockConcurrencyWhile(async () => {
      for (const fiber of this.recovering) await Effect.runPromise(Fiber.interrupt(fiber))
      await Effect.runPromise(Scope.close(this.scope, Exit.succeed(undefined)))
      if (this.directory) await Effect.runPromise(this.directory.close)
      this.directory = undefined
      if (this.journal) await Effect.runPromise(this.journal.close)
      this.journal = undefined
      this.scope = Scope.makeUnsafe()
      this.telemetryContext = undefined
    }) }
  }

  class ThreadObject extends DurableObject<Env & CloudflareObjectBindings> {
    private coordinate: ThreadCoordinate | undefined
    private readonly identityReady = this.ctx.blockConcurrencyWhile(async () => { this.coordinate = await this.ctx.storage.get<ThreadCoordinate>("tardie:thread:coordinate") })
    private journal: ReturnType<typeof objectJournal<Event>> | undefined
    private execution: ReturnType<typeof createActorExecution<Event, Services, State, Contracts>> | undefined
    private scope = Scope.makeUnsafe()
    private readonly recovering = new Set<Fiber.Fiber<void, Error>>()
    private readonly watchdog = createWatchdog({ storage: cloudflareWatchdogStorage(this.ctx.storage, options.alarms), ...options.watchdog,
      recover: () => Effect.suspend(() => this.recover()),
      // @effect-diagnostics-next-line effectSucceedWithVoid:off: Watchdog probes require an absent state with an undefined result type.
      probe: () => Effect.suspend(() => this.execution ? this.execution.probe(this.address()) : Effect.succeed(undefined)),
      invalidate: () => Effect.suspend(() => this.execution ? this.execution.invalidate(this.address()) : Effect.void),
      launch: work => Effect.sync(() => {
        const fiber = Effect.runFork(work)
        this.recovering.add(fiber)
        fiber.addObserver(() => { this.recovering.delete(fiber) })
      }),
    })
    private telemetryContext: Context.Context<{}> | undefined
    private run = <Value>(work: Effect.Effect<Value, Error>) => Effect.suspend(() => {
      if (options.telemetry && !this.telemetryContext) this.telemetryContext = Effect.runSync(Layer.buildWithScope(options.telemetry, this.scope))
      const instrumented = this.telemetryContext ? Effect.provide(work, this.telemetryContext) : work
      return Effect.acquireUseRelease(instrumented.pipe(Effect.forkIn(this.scope)), Fiber.join, Fiber.interrupt)
    })
    private address() { if (!this.coordinate) throw new RuntimeError("Thread DO is not provisioned"); return this.coordinate }
    private storage() {
      if (!this.journal) this.journal = objectJournal({ storage: this.ctx.storage, key: "events", checkpointChunkBytes: options.checkpointChunkBytes, target: this.address(), watchdog: this.watchdog, ...(options.alarms ? { alarms: options.alarms } : {}) })
      return this.journal
    }
    async provision(input: ThreadCreated, initialState?: InitialState): Promise<void> {
      await this.identityReady
      const created = Schema.decodeSync(ThreadCreated, { onExcessProperty: "error" })(input)
      if (created.address.actor !== options.actor.actorName || created.placement !== "independent") throw new RuntimeError("Thread DO requires independent placement for its actor")
      if (this.ctx.id.name !== undefined && this.ctx.id.name !== cloudflareThreadName(created.address)) throw new RuntimeError("Thread coordinate differs from its DO address")
      if (this.coordinate && !isDeepStrictEqual(this.coordinate, created.address)) throw new RuntimeError("Thread DO coordinate identity cannot change")
      if (!this.coordinate) { await this.ctx.storage.put("tardie:thread:coordinate", created.address); await this.ctx.storage.sync(); this.coordinate = created.address }
      const seeded = initialState === undefined ? undefined : await Effect.runPromise(prepareInitialState(options.initialStateAtoms ?? [], initialState))
      await Effect.runPromise(initializeThread(this.storage(), created, seeded))
    }
    private supervisor(): typeof Supervisor.Service {
      const directory = () => this.env.ACTORS.getByName(this.address().instance)
      return {
        allocate: request => coordinateIo(() => directory().allocate(request)).pipe(Effect.map(value => value!)),
        lookup: coordinate => coordinateIo(() => this.env.ACTORS.getByName(coordinate.instance).lookup(coordinate)),
        store: () => Effect.fail(new RuntimeError("Supervisor projections are owned by the Actor DO")),
      }
    }
    private send = (message: MessageDelivery) => createInvocation({
      supervisor: this.supervisor(), reference: coordinate => Effect.succeed(coordinate),
      receive: (target, body, message) => receiptIo(() => this.env.THREADS.getByName(cloudflareThreadName(target)).receive({ target, body, message })),
      from: this.address(), run: this.run,
      ...(options.actorTransport ? { actorTransport: options.actorTransport } : {}), ...(options.transports ? { transports: options.transports } : {}),
    }).send(message)
    private actors() {
      if (!this.execution) this.execution = createActorExecution({ actor: options.actor, actorContext, storage: { thread: coordinate => {
        if (!isDeepStrictEqual(coordinate, this.address())) throw new RuntimeError("Thread runtime cannot open another DO's journal")
        return this.storage()
      } }, services: (coordinate, runtime) => options.services(this.env, coordinate, runtime, this.ctx.storage).pipe(Layer.provideMerge(Layer.merge(Layer.succeed(Supervisor, this.supervisor()), Layer.succeed(Invocation, { send: this.send })))),
        delivery: () => ({ ...options.delivery, address: this.address(), send: this.send }), from: options.from ?? DEFAULT_EXTERNAL_SENDER, run: this.run,
        ...(options.checkpointPolicy ? { checkpointPolicy: options.checkpointPolicy } : {}),
        ...(options.effectInput ? { effectInput: options.effectInput } : {}), ...(options.promises ? { promises: options.promises } : {}), ...(options.executionStream ? { executionStream: options.executionStream } : {}),
        canDrive: () => this.watchdog.status.pipe(Effect.flatMap(entries => entries.get(watchdogKey(this.address()))?.status === "blocked" ? Effect.succeed(false) : options.canDrive ? options.canDrive(this.address()) : Effect.succeed(true))),
      })
      return this.execution
    }
    private registered() { return this.supervisor().lookup(this.address()).pipe(Effect.flatMap(found => found ? Effect.void : Effect.fail(new RuntimeError("Thread is not registered by its supervisor")))) }
    private recover(): Effect.Effect<RecoveryState, Error> {
      return this.registered().pipe(Effect.andThen(Effect.gen({ self: this }, function* () {
        const thread = yield* this.actors().open(this.address())
        yield* thread.resume
        yield* thread.recover
        return thread.recoveryState()
      })))
    }
    async receive(packet: IncomingMessage): Promise<MessageReceipt> {
      await this.identityReady
      if (!isDeepStrictEqual(packet.target, this.address())) throw new RuntimeError("Message target differs from Thread DO identity")
      return Effect.runPromise(this.registered().pipe(Effect.andThen(this.actors().receive(this.address(), packet.body, packet.message))))
    }
    async fetch(request: Request): Promise<Response> {
      return objectResponse(request, () => this.handleRequest(request))
    }
    private async handleRequest(request: Request): Promise<Response> {
      const http = options.http?.(this.env) ?? {}
      if (http.token !== undefined && request.headers.get("authorization") !== `Bearer ${http.token}`) return Response.json({ code: "unauthorized", message: "Unauthorized" }, { status: 401 })
      await this.identityReady
      await Effect.runPromise(this.registered())
      const coordinate = this.address()
      const thread = await Effect.runPromise(this.actors().reference(coordinate))
      const host = { actor: options.actor.actorName, execution: thread.execution,
        getThread: (input: { instance: string; thread: string }) => input.instance === coordinate.instance && input.thread === coordinate.thread ? Effect.succeed(thread) : Effect.fail(new RuntimeError("Request differs from Thread DO identity")),
        methodContracts: () => Effect.succeed(thread.contracts), send: this.send,
        allocateRootThread: (input: Omit<ThreadRequest, "parent">) => this.supervisor().allocate(input).pipe(Effect.map(coordinate => ({ coordinate, receipt: () => Effect.fail(new RuntimeError("Receipt is owned by the target thread")) }))),
        allocateChildThread: (input: Omit<ThreadRequest, "instance" | "parent"> & { readonly parent: ThreadCoordinate }) => this.supervisor().allocate({ ...input, instance: input.parent.instance }).pipe(Effect.map(coordinate => ({ coordinate, receipt: () => Effect.fail(new RuntimeError("Receipt is owned by the target thread")) }))),
      }
      const path = new URL(request.url).pathname
      if (path.includes("/messages")) {
        const handler = HttpRouter.toWebHandler(hostRoutes(host), { disableLogger: true })
        try { return await handler.handler(request) } finally { await handler.dispose() }
      }
      return methodHttp(host, http)(request)
    }
    async alarm() { await this.identityReady; if (this.coordinate) { this.storage(); await Effect.runPromise(this.watchdog.alarm) } }
    async records(): Promise<readonly Recorded<Event>[]> { await this.identityReady; return Effect.runPromise(this.storage().read) }
    async checkpoint(): Promise<StoredCheckpoint | undefined> { await this.identityReady; return Effect.runPromise(this.storage().readCheckpoint) }
    async dispose() { return this.ctx.blockConcurrencyWhile(async () => {
      for (const fiber of this.recovering) await Effect.runPromise(Fiber.interrupt(fiber))
      await Effect.runPromise(Scope.close(this.scope, Exit.succeed(undefined)))
      if (this.execution) await Effect.runPromise(this.execution.close)
      this.execution = undefined
      if (this.journal) await Effect.runPromise(this.journal.close)
      this.journal = undefined
      this.scope = Scope.makeUnsafe()
      this.telemetryContext = undefined
    }) }
  }
  return { ActorObject, ThreadObject }
}
