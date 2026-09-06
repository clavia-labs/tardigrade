import { cloudflareRpcTransport } from "./transport/rpc"
import { DurableObject } from "cloudflare:workers"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { modelAdapters } from "@clavia/tardigrade-model/adapter"
import { type ModelCatalogState } from "@clavia/tardigrade-server/catalog"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { mappedDirectory } from "@clavia/tardigrade-core/transport/directory"
import { directoryRoute } from "@clavia/tardigrade-core/transport/router"
import { isActorEnvelope, type ActorEnvelope } from "@clavia/tardigrade-core/interaction/envelope"
import { ActorInstanceId, type ThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { actorRuntimeOf } from "@clavia/tardigrade-core/runtime"
import type { SandboxCallOutcome } from "@clavia/tardigrade-code/sandbox/service"
import { layerWorkerLoaderSandbox, type SandboxBridgeCall, type SandboxBridgeLease, type WorkerLoaderSandboxLimits } from "@clavia/tardigrade-worker-loader/sandbox"
import { alarmPolicyOf, armAt, scheduledAlarmAt, type AlarmPolicy } from "./alarm"
import { initializeCloudflareThreadSchema } from "./storage"
import { createCloudflareThreadHost, type CloudflareThreadHost } from "./host"
import type { Env } from "./env"
import { DEFAULT_CLOUDFLARE_CHILD_PLACEMENT, type BackgroundTaskOwner, DEFAULT_BACKGROUND_TASK_OWNER, backgroundTaskOwnerOf, retainBackgroundTask, mountedActor, EMPTY_MODEL_SCOPE, modelCatalogForConfig, deployed, directory, modelConfigFrom, modelsFrom, modelLayer, nonNegativeInteger, optionalNonNegativeInteger, sandboxTransportOf, assemblyOf } from "./assembly"

// ThreadDO runs one thread over one SQLite-backed Durable Object.
export class ThreadDO extends DurableObject<Env> {
  private schema: Promise<void> | undefined
  private runtime: Promise<CloudflareThreadHost> | undefined
  private driving: Promise<void> | undefined
  private actorName: string | undefined
  private actorInstance: string | undefined
  private threadId: string | undefined
  private readonly alarmPolicy: AlarmPolicy
  private readonly backgroundTaskOwner: BackgroundTaskOwner
  private readonly sandboxCalls = new Map<
    string,
    (ordinal: number, packageName: string, method: string, args: unknown) => Promise<SandboxCallOutcome>
  >()

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

  async initializeRoot(): Promise<void> {
    await (await this.host()).initializeRoot(Date.now())
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

  async sandboxCallBatch(
    execution: string,
    calls: ReadonlyArray<SandboxBridgeCall>
  ): Promise<ReadonlyArray<SandboxCallOutcome>> {
    const call = this.sandboxCalls.get(execution)
    if (call === undefined) throw new Error(`sandbox execution ${JSON.stringify(execution)} is unavailable`)
    return Promise.all(calls.map((entry) => call(entry.ordinal, entry.packageName, entry.method, entry.args)))
  }

  private async openHost(): Promise<CloudflareThreadHost> {
    const modelConfig = modelConfigFrom(this.env)
    const deployedScope = mountedActor?.modelScope
    if (modelConfig !== undefined && deployedScope === undefined) {
      throw new Error("model configuration requires models.lock.json; run `tdg models lock`")
    }
    const modelScope = modelConfig === undefined || deployedScope === undefined
      ? EMPTY_MODEL_SCOPE
      : await modelCatalogForConfig(modelConfig, deployedScope)
    const models = modelsFrom(this.env, modelConfig)
    const adapters = mountedActor?.modelAdapters ?? modelAdapters()
    for (const provider of Object.values(models?.providers ?? {})) adapters.resolve(provider.protocol)
    const catalog: ModelCatalogState = models === undefined ? { refreshError: "no model is configured" } : { snapshot: modelScope }
    const actorName = this.name()
    const actorInstance = this.instance()
    const selectedAssembly = assemblyOf(actorName, this.env, models, modelScope, catalog)
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
    const durableObjectName = this.ctx.id.name
    if (durableObjectName === undefined) throw new Error("Thread DO requires a named Durable Object")
    const sandboxLayer = layerWorkerLoaderSandbox(
      this.env.LOADER,
      (call): SandboxBridgeLease => {
        const execution = crypto.randomUUID()
        this.sandboxCalls.set(execution, call)
        return {
          binding: this.env.THREADS.getByName(durableObjectName),
          execution,
          close: () => {
            this.sandboxCalls.delete(execution)
          }
        }
      },
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
    const commitObserver = mountedActor?.commitObserverFor?.({ env: this.env, actorInstance, thread: currentThread })
    return createCloudflareThreadHost({
      initializeRoot: async (target) => {
        const supervisor = await directory.actorStub(this.env, target.actor, target.instance, true)
        if (supervisor === undefined) throw new Error("root actor is not deployed")
        await supervisor.initializeRootThread(target.thread)
      },
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
      ...(commitObserver === undefined ? {} : { commitObserver }),
      retainCommitTask: (task: Promise<void>) => retainBackgroundTask(this.ctx, this.backgroundTaskOwner, task),
      layers: (() => {
        const thread = currentThread
        const observer = mountedActor?.inferenceObserverFor?.({ env: this.env, actorInstance, thread })
        const framework = Layer.mergeAll(modelLayer(models, modelScope, adapters, observer), FetchHttpClient.layer, sandboxLayer)
        const application = mountedActor?.layersFor?.({ env: this.env, actorInstance, thread })
        return application === undefined ? framework : Layer.mergeAll(framework, application)
      })(),
      routes: [independentRoute],
      ...(mountedActor?.storeFor === undefined ? {} : { store: mountedActor.storeFor({ env: this.env, actorInstance, thread: currentThread }) }),
      keyOf: actorRuntimeOf(selectedAssembly).keyOf
    })
  }

  private host(): Promise<CloudflareThreadHost> {
    this.runtime ??= this.openHost()
    return this.runtime
  }

  private async arm(): Promise<void> {
    const at = armAt(await this.ctx.storage.getAlarm(), Date.now(), this.alarmPolicy.recoveryDelayMillis)
    if (at !== null) await this.ctx.storage.setAlarm(at)
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

  private async commitTurn(): Promise<void> {
    await scheduler.wait(0)
  }

  // accept stages the work and recovery alarm, crosses their commit turn, and starts reconciliation in that order (tla/DurableExecution.tla, CoveredBeforeDrive).
  private async accept(host: CloudflareThreadHost, stage: () => Promise<void>): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    await stage()
    const at = scheduledAlarmAt(
      current,
      false,
      Date.now(),
      this.alarmPolicy.recoveryDelayMillis,
      await host.nextMethodDeadline()
    )
    if (at !== null && current !== at) await this.ctx.storage.setAlarm(at)
    await this.commitTurn()
    host.publishStaged()
    this.kick(host)
  }

  // kick starts reconciliation while the Durable Object is active and leaves its alarm armed until the host rests (test/actor.workers.ts, "a mounted actor exposes durable methods").
  private kick(host: CloudflareThreadHost): void {
    if (this.driving !== undefined) return
    let failed = false
    const driving = (async () => {
      try {
        await host.drive()
        await this.synchronizeAlarm(host)
      } catch (cause) {
        failed = true
        console.error("actor drive failed; the alarm remains armed", cause)
      }
    })()
    this.driving = driving
    retainBackgroundTask(this.ctx, this.backgroundTaskOwner, driving)
    void driving.finally(() => {
      if (this.driving === driving) this.driving = undefined
      if (!failed && host.work() > 0) this.kick(host)
    })
  }

  async append(thread: string, event: Event): Promise<boolean> {
    if (!this.initialized()) return false
    const ownedThread = this.thread()
    if (ownedThread !== thread) {
      throw new Error("request thread does not match the Thread DO identity")
    }
    const stamped = event.at === undefined ? { ...event, at: Date.now() } : event
    const host = await this.host()
    await this.accept(host, () => host.stageRoot(stamped))
    return true
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

  async stageCreation(envelope: ActorEnvelope): Promise<void> {
    this.validateDelivery(envelope)
    if (envelope.lineage === undefined) throw new Error("staged thread creation requires lineage")
    await (await this.host()).stage(envelope)
    await this.ctx.storage.sync()
  }

  async commitCreation(): Promise<void> {
    const host = await this.host()
    await this.arm()
    await this.commitTurn()
    host.publishStaged()
    this.kick(host)
  }

  async deliver(envelope: ActorEnvelope): Promise<void> {
    this.validateDelivery(envelope)
    const host = await this.host()
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

  async alarm(): Promise<void> {
    const at = Date.now()
    const host = await this.host()
    await this.arm()
    await this.commitTurn()
    await host.recordAlarm(at)
    await host.recover()
    await this.synchronizeAlarm(host)
  }
}
