import { AlarmScheduler } from "./alarm-scheduler"
import { threadCreatedOf, type ThreadCreated } from "@clavia/tardigrade-core/interaction/relations"
import { eventTail, inferenceTail } from "@clavia/tardigrade-http/sse"
import { makeInferenceStream } from "@clavia/tardigrade-http/inference-stream"
import { summaryOf, type ThreadSummary } from "@clavia/tardigrade-http/projections"
import { publicThreadId } from "@clavia/tardigrade-host/thread-compat"
import { CommitSignal, streamPolicyOf } from "./transport/stream"
import { cloudflareRpcTransport } from "./transport/rpc"
import { actorObjectNameOf } from "./transport/directory"
import { forkOutcomeOf } from "@clavia/tardigrade-host/fork"
import { validateDelivery } from "@clavia/tardigrade-host/delivery"
import { DurableObject } from "cloudflare:workers"
import { Effect, Layer, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { SqliteClient } from "@effect/sql-sqlite-do"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { mappedDirectory } from "@clavia/tardigrade-core/transport/directory"
import { directoryRoute } from "@clavia/tardigrade-core/transport/router"
import { isActorEnvelope, type ActorEnvelope } from "@clavia/tardigrade-core/interaction/envelope"
import { ActorInstanceId, type ThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { actorRuntimeOf } from "@clavia/tardigrade-core/runtime"
import { layerWorkerLoaderSandbox, type WorkerLoaderSandboxLimits } from "@clavia/tardigrade-worker-loader/sandbox"
import { alarmPolicyOf, scheduledAlarmAt, type AlarmPolicy } from "./alarm"
import { initializeCloudflareThreadSchema } from "./storage"
import { createCloudflareThreadHost, type CloudflareThreadHost } from "./host"
import type { Env } from "./env"
import { DEFAULT_CLOUDFLARE_CHILD_PLACEMENT, type BackgroundTaskOwner, DEFAULT_BACKGROUND_TASK_OWNER, backgroundTaskOwnerOf, retainBackgroundTask, mountedActor, EMPTY_MODEL_SCOPE, modelStateFrom, deployed, directory, modelsFrom, modelLayer, nonNegativeInteger, optionalNonNegativeInteger, sandboxTransportOf, assemblyOf } from "./assembly"

// ThreadDO runs one thread over one SQLite-backed Durable Object.
export class ThreadDO extends DurableObject<Env> {
  private readonly commits = new CommitSignal()
  private readonly inference = makeInferenceStream()
  private schema: Promise<void> | undefined
  private runtime: Promise<CloudflareThreadHost> | undefined
  private alarmScheduler: AlarmScheduler | undefined
  private actorName: string | undefined
  private actorInstance: string | undefined
  private threadId: string | undefined
  private readonly alarmPolicy: AlarmPolicy
  private readonly backgroundTaskOwner: BackgroundTaskOwner

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.alarmPolicy = alarmPolicyOf(env.TARDIGRADE_ALARM_DELAY_MILLIS === undefined
      ? {}
      : { recoveryDelayMillis: nonNegativeInteger(env.TARDIGRADE_ALARM_DELAY_MILLIS, 0, "TARDIGRADE_ALARM_DELAY_MILLIS") })
    this.backgroundTaskOwner = backgroundTaskOwnerOf(
      env.TARDIGRADE_BACKGROUND_TASK_OWNER,
      mountedActor?.backgroundTaskOwner ?? DEFAULT_BACKGROUND_TASK_OWNER
    )
  }

  async init(name: string, instance: string, thread: string): Promise<void> {
    if (!deployed(name)) throw new Error(`actor ${JSON.stringify(name)} is not deployed`)
    if (!Schema.is(ActorInstanceId)(instance)) throw new Error("invalid actor instance id")
    this.schema ??= Effect.runPromise(initializeCloudflareThreadSchema.pipe(
      Effect.provide(SqliteClient.layer({ storage: this.ctx.storage }))
    ))
    await this.schema
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO thread_identity (singleton, actor, instance, thread) VALUES (1, ?, ?, ?)",
      name,
      instance,
      thread
    )
    const identity = this.identity()
    if (identity.actor !== name) throw new Error("actor definition does not match the Thread DO identity")
    if (identity.instance !== instance) throw new Error("actor instance does not match the Thread DO identity")
    if (identity.thread !== thread) throw new Error("thread does not match the Thread DO identity")
  }

  // provision records an inactive identity without scheduling work until supervisor setup completes (test/actor.workers.ts).
  async provision(created: ThreadCreated, initial: ReadonlyArray<Event> = [created]): Promise<ThreadCreated> {
    const identity = this.identity()
    if (created.address.actor !== identity.actor || created.address.instance !== identity.instance || created.address.thread !== identity.thread) {
      throw new Error("creation address does not match the Thread DO identity")
    }
    const host = await this.host()
    const result = await host.appendAt(initial, 0)
    if (result.appended === 0 && initial.some((event) => event.type === "ThreadForked")) forkOutcomeOf(await host.read(), initial, identity.thread)
    await this.ctx.storage.sync()
    const recorded = threadCreatedOf(await host.read())
    if (recorded === undefined) throw new Error("thread creation was not recorded")
    return recorded
  }

  async exists(name: string, instance: string, thread: string): Promise<boolean> {
    const table = this.ctx.storage.sql.exec<{ present: number }>(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'thread_identity'"
    ).toArray()[0]
    if (table === undefined) return false
    const row = this.ctx.storage.sql.exec<{ actor: string; instance: string; thread: string }>(
      "SELECT actor, instance, thread FROM thread_identity WHERE singleton = 1"
    ).toArray()[0]
    return row?.actor === name && row.instance === instance && row.thread === thread
  }

  private initialized(): boolean {
    return this.ctx.storage.sql.exec<{ present: number }>(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'thread_identity'"
    ).toArray()[0] !== undefined
  }

  private identity(): { readonly actor: string; readonly instance: string; readonly thread: string } {
    const row = this.ctx.storage.sql.exec<{ actor: string; instance: string; thread: string }>(
      "SELECT actor, instance, thread FROM thread_identity WHERE singleton = 1"
    ).toArray()[0]
    if (row === undefined) throw new Error("Thread DO has not been initialized")
    this.actorName ??= row.actor
    this.actorInstance ??= row.instance
    this.threadId ??= row.thread
    return row
  }

  private name(): string {
    return this.actorName ?? this.identity().actor
  }

  private instance(): string {
    return this.actorInstance ?? this.identity().instance
  }

  private thread(): string {
    return this.threadId ?? this.identity().thread
  }

  private async openHost(): Promise<CloudflareThreadHost> {
    const state = await modelStateFrom(this.env)
    const modelScope = state?.catalog.snapshot ?? EMPTY_MODEL_SCOPE
    const models = modelsFrom(this.env, state?.model)
    const actorName = this.name()
    const actorInstance = this.instance()
    const selectedAssembly = assemblyOf(actorName)
    if (selectedAssembly === undefined) throw new Error(`actor ${JSON.stringify(actorName)} is not deployed`)
    const currentThread = this.thread()
    const sandboxCpuMs = optionalNonNegativeInteger(this.env.TARDIGRADE_SANDBOX_CPU_MILLIS, "TARDIGRADE_SANDBOX_CPU_MILLIS")
    const sandboxSubRequests = optionalNonNegativeInteger(
      this.env.TARDIGRADE_SANDBOX_SUBREQUESTS,
      "TARDIGRADE_SANDBOX_SUBREQUESTS"
    )
    const sandboxLimits: WorkerLoaderSandboxLimits = {
      ...(sandboxCpuMs === undefined ? {} : { cpuMs: sandboxCpuMs }),
      ...(sandboxSubRequests === undefined ? {} : { subRequests: sandboxSubRequests })
    }
    const sandboxLayer = layerWorkerLoaderSandbox(
      this.env.LOADER,
      {
        transport: sandboxTransportOf(this.env.TARDIGRADE_SANDBOX_TRANSPORT),
        ...(this.env.TARDIGRADE_SANDBOX_LOG_CAP_BYTES === undefined
          ? {}
          : { logCapBytes: nonNegativeInteger(this.env.TARDIGRADE_SANDBOX_LOG_CAP_BYTES, 0, "TARDIGRADE_SANDBOX_LOG_CAP_BYTES") }),
        ...(Object.keys(sandboxLimits).length === 0 ? {} : { limits: sandboxLimits })
      }
    )
    const independentTransport = cloudflareRpcTransport(this.env, {
      deployed, defaultChildPlacement: mountedActor?.defaultChildPlacement ?? DEFAULT_CLOUDFLARE_CHILD_PLACEMENT
    })
    const independentRoute = directoryRoute(
      independentTransport,
      mappedDirectory((id: ThreadAddress) => {
        return id.actor === actorName && id.instance === actorInstance && id.thread === currentThread ? undefined : id
      }),
      isActorEnvelope,
      (envelope) => envelope.link.target
    )
    const layerContext = { env: this.env, storage: this.ctx.storage, actorInstance, thread: currentThread }
    const commitObserver = mountedActor?.commitObserverFor?.(layerContext)
    return createCloudflareThreadHost({
      threadAllocator: {
        allocate: (request) => Effect.promise(async () => {
          const target = request.kind === "root" ? request.coordinate : request.parent
          const supervisor = await directory.actorStub(this.env, target.actor, target.instance, true)
          if (supervisor === undefined) throw new Error("allocation actor is not deployed")
          return supervisor.allocateThread(request)
        })
      },
      storage: this.ctx.storage,
      actorName,
      actorInstance,
      thread: currentThread,
      actor: selectedAssembly,
      onPublish: (head) => this.commits.notify(head),
      ...(commitObserver === undefined ? {} : { commitObserver }),
      retainCommitTask: (task: Promise<void>) => retainBackgroundTask(this.ctx, this.backgroundTaskOwner, task),
      layers: (() => {
        const observer = mountedActor?.inferenceObserverFor?.(layerContext)
        const framework = Layer.mergeAll(modelLayer(models, modelScope, {
          ...observer,
          onDelta: (delta) => Effect.andThen(this.inference.observer.onDelta(delta), observer?.onDelta(delta) ?? Effect.void)
        }), FetchHttpClient.layer, sandboxLayer)
        const application = mountedActor?.layersFor?.(layerContext)
        return application === undefined ? framework : Layer.mergeAll(framework, application)
      })(),
      routes: [independentRoute],
      ...(mountedActor?.storeFor === undefined ? {} : { store: mountedActor.storeFor(layerContext) }),
      keyOf: actorRuntimeOf(selectedAssembly).keyOf
    })
  }

  private host(): Promise<CloudflareThreadHost> {
    this.runtime ??= this.openHost()
    return this.runtime
  }

  private scheduler(): AlarmScheduler {
    return this.alarmScheduler ??= new AlarmScheduler(this.ctx.storage, this.alarmPolicy.recoveryDelayMillis)
  }

  private async synchronizeAlarm(host: CloudflareThreadHost): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    const at = scheduledAlarmAt(
      current,
      await host.resting(),
      Date.now(),
      this.alarmPolicy.recoveryDelayMillis,
      await host.nextMethodDeadline()
    )
    if (at === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm()
    } else if (current !== at) {
      await this.ctx.storage.setAlarm(at)
    }
  }

  // accept persists input and an immediate alarm before publishing (test/invocation-depth.workers.ts).
  private async accept(host: CloudflareThreadHost, stage: () => Promise<void>): Promise<void> {
    await this.scheduler().admit(async () => {
      if (await this.ctx.storage.get<boolean>("threadReady") !== true) {
        const identity = this.identity()
        const owner = await directory.actorStub(this.env, identity.actor, identity.instance, false)
        if (owner === undefined || !await owner.isThreadReady(identity.thread)) throw new Error("thread is not ready; allocate it before delivery")
        await this.ctx.storage.put("threadReady", true)
      }
      await stage()
    }, () => host.publishStaged())
  }

  async append(thread: string, event: Event): Promise<boolean> {
    if (!this.initialized()) return false
    const ownedThread = this.thread()
    if (ownedThread !== thread) {
      throw new Error("request thread does not match the Thread DO identity")
    }
    const stamped = event.at === undefined ? { ...event, at: Date.now() } : event
    const host = await this.host()
    validateDelivery({ target: this.identity(), event: stamped, keyOf: actorRuntimeOf(assemblyOf(this.name())!).keyOf }, await host.read())
    await this.accept(host, () => host.stageRoot(stamped))
    return true
  }

  // appendAt admits the complete fork batch before alarm-driven execution (packages/core/tla/interaction/Fork.tla, AtomicPublication).
  async appendAt(events: ReadonlyArray<Event>, expectedHead: number): Promise<{ readonly appended: number; readonly head: number }> {
    if (!this.initialized()) throw new Error("Thread DO has not been initialized")
    const host = await this.host()
    let result = { appended: 0, head: 0 }
    await this.accept(host, async () => { result = await host.appendAt(events, expectedHead) })
    return result
  }

  private validateDelivery(envelope: ActorEnvelope): void {
    if (envelope.link.target.actor !== this.name()) throw new Error("delivery target does not match actor definition")
    if (envelope.link.target.instance !== this.instance()) throw new Error("delivery target does not match actor instance")
    if (envelope.lineage !== undefined && (
      envelope.lineage.parent.actor !== envelope.link.target.actor ||
      envelope.lineage.parent.instance !== envelope.link.target.instance
    )) {
      throw new Error("a child thread must inherit its actor instance")
    }
    const ownedThread = this.thread()
    if (envelope.link.target.thread !== ownedThread) {
      throw new Error("delivery target does not match actor thread")
    }
  }

  async commitCreation(): Promise<ThreadCreated | undefined> {
    if (!this.initialized()) return undefined
    const host = await this.host()
    const created = threadCreatedOf(await host.read())
    if (created === undefined) return undefined
    await this.scheduler().admit(
      () => this.ctx.storage.put("threadReady", true),
      () => host.publishStaged()
    )
    return created
  }

  async deliver(envelope: ActorEnvelope): Promise<void> {
    if (!this.initialized()) throw new Error("thread is not ready; allocate it before delivery")
    this.validateDelivery(envelope)
    const host = await this.host()
    validateDelivery({ target: envelope.link.target, event: envelope.event, link: envelope.link, call: envelope.call, lineage: envelope.lineage,
      keyOf: actorRuntimeOf(assemblyOf(this.name())!).keyOf }, await host.read())
    await this.accept(host, () => host.stage(envelope))
  }

  async events(thread: string): Promise<ReadonlyArray<Event>> {
    const ownedThread = this.thread()
    if (ownedThread !== thread) {
      throw new Error("request thread does not match the Thread DO identity")
    }
    return (await this.host()).read()
  }

  async queryEvents(
    thread: string,
    query: { readonly after: number; readonly limit: number; readonly types?: ReadonlyArray<string> }
  ): Promise<ReadonlyArray<{ readonly seq: number; readonly event: Event }>> {
    const ownedThread = this.thread()
    if (ownedThread !== thread) {
      throw new Error("request thread does not match the Thread DO identity")
    }
    if (!Number.isSafeInteger(query.after) || query.after < 0) throw new Error("event query after must be a non-negative integer")
    if (!Number.isSafeInteger(query.limit) || query.limit < 0) throw new Error("event query limit must be a non-negative integer")
    if (query.limit === 0) return []
    const host = await this.host()
    const wanted = query.types === undefined ? undefined : new Set(query.types)
    const selected: Array<{ readonly seq: number; readonly event: Event }> = []
    let mark = query.after
    while (selected.length < query.limit) {
      const rows = await host.readPage(mark, query.limit)
      if (rows.length === 0) break
      for (const row of rows) {
        if (wanted === undefined || wanted.has(row.event.type)) selected.push(row)
        if (selected.length === query.limit) break
      }
      mark = rows[rows.length - 1]!.seq
      if (rows.length < query.limit) break
    }
    return selected
  }

  async status(): Promise<{ readonly status: "resting" | "driving"; readonly dirty: number }> {
    const host = await this.host()
    return { status: await host.resting() ? "resting" : "driving", dirty: host.work() }
  }

  async summary(): Promise<ThreadSummary> {
    const events = await (await this.host()).read()
    const parent = threadCreatedOf(events)?.parent
    const resting = await (await this.host()).resting()
    return summaryOf(
      publicThreadId(this.thread()), events,
      () => resting ? "settled" : "running",
      parent === undefined ? undefined : publicThreadId(parent.thread)
    )
  }

  async eventStream(after: number): Promise<ReadableStream<Uint8Array> | undefined> {
    const host = await this.host()
    const first = await host.readPage(0, 1)
    if (threadCreatedOf(first.map((row) => row.event)) === undefined) return undefined
    const policy = streamPolicyOf(mountedActor?.streaming)
    return Stream.toReadableStream(eventTail(
      (_thread, cursor, limit) => Effect.promise(() => host.readPage(cursor, limit)),
      (_thread, cursor) => this.commits.awaitHead(cursor),
      this.thread(), after, policy.pageSize, policy.heartbeatMillis
    ))
  }

  inferenceStream(): ReadableStream<Uint8Array> {
    const policy = streamPolicyOf(mountedActor?.streaming)
    return Stream.toReadableStream(inferenceTail(this.inference, this.instance(), this.thread(), policy.heartbeatMillis, policy.inferenceBufferCapacity))
  }

  async alarm(): Promise<void> {
    const host = await this.host()
    await this.scheduler().run(async () => {
      const identity = this.identity()
      await this.env.ACTORS.getByName(actorObjectNameOf(identity.actor, identity.instance)).ensureThreadReady(identity.thread)
      await host.recordAlarm(Date.now())
      await host.recover()
    }, () => this.synchronizeAlarm(host))
  }
}
