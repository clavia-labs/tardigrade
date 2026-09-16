import type { TreeBounds } from "@clavia/tardigrade-client/contract"
import { threadCreatedOf } from "@clavia/tardigrade-core/interaction/relations"
import { forkBatchFor, forkRootAllocation, isForkRefused, resolveForkCheckpoint, type ForkRefusal } from "@clavia/tardigrade-host/fork"
import type { ForkCheckpoint } from "@clavia/tardigrade-core/log"
import { childKeyOf } from "@clavia/tardigrade-core/actor/coordinate"
import { threadObjectNameOf } from "./transport/directory"
import { DurableObject } from "cloudflare:workers"
import { Clock, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { publicThreadId } from "@clavia/tardigrade-host/thread-compat"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { eventLogFrom } from "@clavia/tardigrade-core/log"
import { type ActorEnvelope } from "@clavia/tardigrade-core/interaction/envelope"
import { ActorInstanceId, isThreadAddress, type ThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { actorEventKeyOf, actorThreadsOf, type ActorThreadRecord } from "@clavia/tardigrade-core/actor"
import { upcastThreadRequest } from "@clavia/tardigrade-core/actor/log/upcast"
import { ThreadAllocator, allocateThread } from "@clavia/tardigrade-core/actor/allocation"
import { registeredThreadAllocator, threadRequestOf } from "@clavia/tardigrade-host/allocation"
import { threadSupervisorDriver, threadSupervisorKeyOf } from "@clavia/tardigrade-host/thread-supervisor"
import { hostThreadAllocator } from "@clavia/tardigrade-host/allocation"
import { ThreadProvisioner, threadCreationFor, threadSupervisor, threadAllocationKey, type ThreadSupervisor } from "@clavia/tardigrade-core/actor/supervisor"
import { Router } from "@clavia/tardigrade-core/transport/router"
import { Self } from "@clavia/tardigrade-core/runtime"
import { isActorEnvelope } from "@clavia/tardigrade-core/interaction/envelope"
import { cloudflareRpcTransport } from "./transport/rpc"
import { sqlThreadDirectory } from "@clavia/tardigrade-host/allocation-sql"
import type { ThreadAllocation } from "@clavia/tardigrade-core/actor/allocation"
import { sameThreadAddress, type ChildPlacement } from "@clavia/tardigrade-core/interaction/relations"
import { restingActor } from "@clavia/tardigrade-core/runtime"
import { alarmPolicyOf, armAt, scheduledAlarmAt, type AlarmPolicy } from "./alarm"
import { initializeCloudflareActorSchema, CloudflareEventStore } from "./storage"
import type { Env } from "./env"
import { mountedActor, deployed, nonNegativeInteger, DEFAULT_CLOUDFLARE_CHILD_PLACEMENT } from "./assembly"

export interface ActorThreadNode {
  readonly id: string
  readonly parent?: string
  readonly depth: number
  readonly placement?: ChildPlacement
  readonly children: ReadonlyArray<ActorThreadNode>
}

// threadTreeOf builds registered threads within the requested bounds; an unknown root returns undefined (test/actor.workers.ts).
const threadTreeOf = (
  rows: ReadonlyArray<ActorThreadRecord>,
  bounds: TreeBounds = {}
): ReadonlyArray<ActorThreadNode> | undefined => {
  const entries = new Map<string, Omit<ActorThreadNode, "children">>()
  const children = new Map<string, string[]>()
  const roots: string[] = []
  for (const row of rows) {
    const id = publicThreadId(row.thread)
    if (entries.has(id)) throw new Error(`ambiguous public thread id ${JSON.stringify(id)}: multiple stored addresses exist`)
    const parent = row.parentThread === undefined ? undefined : publicThreadId(row.parentThread)
    entries.set(id, {
      id,
      ...(parent === undefined ? {} : { parent }),
      depth: row.depth,
      ...(row.placement === null ? {} : { placement: row.placement })
    })
    if (parent === undefined) roots.push(id)
    else children.set(parent, [...children.get(parent) ?? [], id])
  }
  const { root, maxDepth, maxNodes } = bounds
  if (root !== undefined && !entries.has(root)) return undefined
  const visited = new Set<string>()
  let built = 0
  const node = (id: string, ancestors: ReadonlySet<string>, level: number): ActorThreadNode | undefined => {
    if (maxNodes !== undefined && built >= maxNodes) return undefined
    if (ancestors.has(id)) throw new Error(`thread tree contains a cycle at ${JSON.stringify(id)}`)
    const entry = entries.get(id)
    if (entry === undefined) throw new Error(`thread tree is missing ${JSON.stringify(id)}`)
    built += 1
    visited.add(id)
    const next = new Set(ancestors).add(id)
    const descendants = (maxDepth === undefined || level < maxDepth) && (maxNodes === undefined || built < maxNodes)
      ? nodes([...children.get(id) ?? []].sort(), next, level + 1)
      : []
    return { ...entry, children: descendants }
  }
  const nodes = (ids: ReadonlyArray<string>, ancestors: ReadonlySet<string>, level: number): ActorThreadNode[] => {
    const tree: ActorThreadNode[] = []
    for (const id of ids) {
      const result = node(id, ancestors, level)
      if (result === undefined) break
      tree.push(result)
    }
    return tree
  }
  const tree = nodes(root === undefined ? roots.sort() : [root], new Set(), 0)
  // Partial reads cannot establish whether the full roster is connected (test/actor.workers.ts).
  if (root === undefined && maxDepth === undefined && maxNodes === undefined && visited.size !== entries.size) {
    throw new Error("thread tree contains an orphan or cycle")
  }
  return tree
}

// ActorDO reconciles one actor instance from its durable event log.
export class ActorDO extends DurableObject<Env> {
  private creation: Promise<ReturnType<typeof hostThreadAllocator>> | undefined
  private definition: ThreadSupervisor | undefined
  private readiness: ReturnType<typeof threadSupervisorDriver> | undefined
  private schema: Promise<void> | undefined
  private eventStore: Promise<CloudflareEventStore> | undefined
  private actorName: string | undefined
  private actorInstance: string | undefined
  private readonly database = ManagedRuntime.make(SqliteClient.layer({ storage: this.ctx.storage }))
  private readonly alarmPolicy: AlarmPolicy

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.alarmPolicy = alarmPolicyOf(env.TARDIGRADE_ALARM_DELAY_MILLIS === undefined
      ? {}
      : { recoveryDelayMillis: nonNegativeInteger(env.TARDIGRADE_ALARM_DELAY_MILLIS, 0, "TARDIGRADE_ALARM_DELAY_MILLIS") })
  }

  async init(name: string, instance: string): Promise<void> {
    if (!deployed(name)) throw new Error(`actor ${JSON.stringify(name)} is not deployed`)
    if (!Schema.is(ActorInstanceId)(instance)) throw new Error("invalid actor instance id")
    this.schema ??= this.database.runPromise(initializeCloudflareActorSchema)
    await this.schema
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO actor_identity (singleton, actor, instance) VALUES (1, ?, ?)", name, instance)
    const identity = this.identity()
    if (identity.actor !== name) throw new Error("actor definition does not match the durable host identity")
    if (identity.instance !== instance) throw new Error("actor instance does not match the durable host identity")
  }

  async exists(name: string, instance: string): Promise<boolean> {
    const table = this.ctx.storage.sql.exec<{ present: number }>(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'actor_identity'"
    ).toArray()[0]
    if (table === undefined) return false
    const row = this.ctx.storage.sql.exec<{ actor: string; instance: string }>(
      "SELECT actor, instance FROM actor_identity WHERE singleton = 1"
    ).toArray()[0]
    return row?.actor === name && row.instance === instance
  }

  private identity(): { readonly actor: string; readonly instance: string } {
    const row = this.ctx.storage.sql.exec<{ actor: string; instance: string }>(
      "SELECT actor, instance FROM actor_identity WHERE singleton = 1"
    ).toArray()[0]
    if (row === undefined) throw new Error("Actor DO has not been initialized")
    this.actorName ??= row.actor
    this.actorInstance ??= row.instance
    return row
  }

  private store(): Promise<CloudflareEventStore> {
    this.eventStore ??= this.database.runPromise(SqliteClient.SqliteClient).then(
      (sql) => new CloudflareEventStore(sql, (event) => actorEventKeyOf(event) ?? threadSupervisorKeyOf(this.definition, event))
    )
    return this.eventStore
  }

  private async events(): Promise<ReadonlyArray<Event>> {
    return this.database.runPromise((await this.store()).read)
  }

  private async threads(): Promise<ReadonlyArray<ActorThreadRecord>> {
    return actorThreadsOf(await this.events())
  }

  private async resting(): Promise<boolean> {
    await this.allocator()
    return restingActor(this.definition!, await this.events())
  }

  private async synchronizeAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    const at = scheduledAlarmAt(
      current,
      await this.resting(),
      Date.now(),
      this.alarmPolicy.recoveryDelayMillis,
      undefined
    )
    if (at === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm()
    } else if (current !== at) {
      await this.ctx.storage.setAlarm(at)
    }
  }

  private async reconcile(): Promise<void> {
    await this.allocator()
    await this.readiness!.drive()
    await this.ctx.storage.sync()
  }

  async createThread(name?: string, options: { readonly key?: string; readonly parent?: string } = {}): Promise<ThreadAddress> {
    const identity = this.identity()
    if (name !== undefined && options.key !== undefined) throw new Error("named allocations do not accept a separate key")
    const key = name === undefined ? { key: options.key ?? crypto.randomUUID() } : {}
    if (options.parent !== undefined) {
      const parent = (await this.threads()).find((entry) => entry.thread === options.parent && entry.state === "registered")
      if (parent === undefined) throw new Error("parent thread does not exist")
      return this.allocateThread({ kind: "child", parent: { ...identity, thread: options.parent }, child: childKeyOf(name ?? "unnamed"), ...key })
    }
    return this.allocateThread({ kind: "root", coordinate: { ...identity, thread: name ?? "" }, ...key })
  }

  // forkThread copies source rows 1..seq onto a runnable root. Refusals return as data because a thrown class does not survive the RPC boundary (transport/http.ts).
  async forkThread(source: string, checkpoint: ForkCheckpoint, name?: string): Promise<
    | { readonly ok: true; readonly coordinate: ThreadAddress; readonly seq: number }
    | { readonly ok: false; readonly refusal: ForkRefusal; readonly message: string }
  > {
    try {
      const identity = this.identity()
      const sourceEntry = (await this.threads()).find((entry) => entry.thread === source && entry.state === "registered")
      const sourceEvents = sourceEntry === undefined
        ? []
        : await this.env.THREADS.getByName(threadObjectNameOf(identity.actor, identity.instance, source)).events(source)
      const seq = resolveForkCheckpoint(sourceEvents, checkpoint)
      const sourceCoordinate = { ...identity, thread: source }
      forkBatchFor(sourceEvents, { source: sourceCoordinate, seq, dest: name ?? "" }, Date.now())
      const dest = await this.allocateThread(forkRootAllocation(identity, name, { source: sourceCoordinate, seq }))
      return { ok: true, coordinate: dest, seq }
    } catch (failure) {
      if (isForkRefused(failure)) return { ok: false, refusal: failure.refusal, message: failure.message }
      throw failure
    }
  }

  private async reserveThread(request: ThreadAllocation): Promise<ThreadAddress> {
    const identity = this.identity()
    const scope = request.kind === "root" ? request.coordinate : request.parent
    if (scope.actor !== identity.actor || scope.instance !== identity.instance) throw new Error("allocation requires the owning actor directory")
    const sql = await this.database.runPromise(SqliteClient.SqliteClient)
    const store = sqlThreadDirectory(sql, "events", (target, existingRoot) =>
      sql<{ event: string }>`SELECT event FROM events
        WHERE json_extract(event, '$.type') = 'ThreadRequested' AND json_extract(event, '$.thread') = ${target.thread}`.pipe(
        Effect.map((rows) => rows.length > 0 && (!existingRoot || rows.some((row) => upcastThreadRequest(JSON.parse(row.event)).parentThread !== undefined))), Effect.orDie
      ), this.definition!.methods.requestThread)
    const target = await Effect.runPromise(allocateThread(request).pipe(Effect.provideService(
      ThreadAllocator, mountedActor?.threadAllocator ?? registeredThreadAllocator({
        get: (key) => Effect.promise(() => this.database.runPromise(store.get(key))),
        claim: (key, target, existingRoot, request) => Effect.promise(() => this.database.runPromise(store.claim(key, target, existingRoot, request)))
      }, mountedActor?.allocation)
    )))
    const at = armAt(await this.ctx.storage.getAlarm(), Date.now(), this.alarmPolicy.recoveryDelayMillis)
    if (at !== null) await this.ctx.storage.setAlarm(at)
    const assigned = await this.database.runPromise(store.claim(threadAllocationKey(request), target, request.kind === "root", request))
    if (assigned !== target.thread) throw new Error("thread reservation conflicts with an existing assignment")
    return target
  }

  private allocator(): Promise<ReturnType<typeof hostThreadAllocator>> {
    return this.creation ??= this.openAllocator()
  }

  private async openAllocator(): Promise<ReturnType<typeof hostThreadAllocator>> {
    this.definition = mountedActor?.supervisor ?? threadSupervisor()
    const store = await this.store()
    const transport = cloudflareRpcTransport(this.env, { deployed, defaultChildPlacement: mountedActor?.defaultChildPlacement ?? DEFAULT_CLOUDFLARE_CHILD_PLACEMENT })
    this.readiness = threadSupervisorDriver(this.definition, eventLogFrom(store), Layer.succeed(ThreadProvisioner, {
      create: (input) => Effect.flatMap(Clock.currentTimeMillis, (at) => Effect.promise(async () => {
        const target = input.target
        const stub = this.env.THREADS.getByName(threadObjectNameOf(target.actor, target.instance, target.thread))
        await stub.init(target.actor, target.instance, target.thread)
        if (input.request.kind === "root" && input.request.fork !== undefined) {
          const fork = input.request.fork
          const events = await this.env.THREADS.getByName(threadObjectNameOf(fork.source.actor, fork.source.instance, fork.source.thread)).events(fork.source.thread)
          const batch = forkBatchFor(events, { source: fork.source, seq: fork.seq, dest: target.thread }, at)
          return stub.provision(threadCreatedOf(batch)!, batch)
        }
        const parent = input.request.kind === "child" ? input.request.parent : undefined
        const events = parent === undefined ? [] : await this.env.THREADS.getByName(threadObjectNameOf(parent.actor, parent.instance, parent.thread)).events(parent.thread)
        return stub.provision(threadCreationFor(input, threadCreatedOf(events), mountedActor?.defaultChildPlacement ?? DEFAULT_CLOUDFLARE_CHILD_PLACEMENT, at))
      })),
      register: (created) => Effect.promise(async () => {
        await this.env.THREADS.getByName(threadObjectNameOf(created.address.actor, created.address.instance, created.address.thread)).commitCreation()
      })
    }), (operation) => this.database.runPromise(operation.pipe(
      Effect.provideService(Self, { ...this.identity(), thread: "" }),
      Effect.provideService(Router, { send: (envelope) => isActorEnvelope(envelope)
        ? transport.send(envelope.link.target, envelope)
        : Effect.die(new Error("supervisor routing requires an actor envelope")) })
    )))
    const identity = this.identity()
    return hostThreadAllocator({
      read: async (target) => {
        const stub = this.env.THREADS.getByName(threadObjectNameOf(target.actor, target.instance, target.thread))
        return await stub.exists(target.actor, target.instance, target.thread) ? stub.events(target.thread) : []
      },
      placement: mountedActor?.defaultChildPlacement ?? DEFAULT_CLOUDFLARE_CHILD_PLACEMENT,
      supervisor: this.readiness,
      owns: (target) => target.actor === identity.actor && target.instance === identity.instance,
      record: async (target) => (await this.threads()).find((entry) => entry.thread === target.thread),
      reserve: (request) => this.reserveThread(request)
    })
  }

  async allocateThread(request: ThreadAllocation): Promise<ThreadAddress> {
    return Effect.runPromise((await this.allocator()).allocate(request))
  }

  async ensureThreadReady(thread: string, request?: ThreadAllocation): Promise<void> {
    const target = { ...this.identity(), thread }
    const record = (await this.threads()).find((entry) => entry.thread === thread)
    await Effect.runPromise((await this.allocator()).ensure(target, request ?? threadRequestOf(target, record)))
  }

  // deliverChild records creation after the child log and actor supervisor accept the request (tla/ThreadCreation.tla, CreatedHasAccepted).
  async deliverChild(envelope: ActorEnvelope): Promise<void> {
    const identity = this.identity()
    const target = envelope.link.target
    const lineage = envelope.lineage
    if (lineage === undefined) throw new Error("child delivery requires lineage")
    if (target.actor !== identity.actor || target.instance !== identity.instance) {
      throw new Error("a child thread must inherit its actor instance")
    }
    if (!isThreadAddress(envelope.link.source) || !sameThreadAddress(envelope.link.source, lineage.parent)) {
      throw new Error("a child thread lineage must match its delivery source")
    }
    const threads = await this.threads()
    const parent = threads.find((entry) => entry.thread === lineage.parent.thread)
    if (parent === undefined || parent.state !== "registered") throw new Error("a child thread requires a registered parent")
    if (lineage.depth !== Number(parent.depth) + 1) throw new Error("a child thread depth must follow its parent")
    const existing = threads.find((entry) => entry.thread === target.thread)
    const placement = lineage.placement ?? mountedActor?.defaultChildPlacement ?? DEFAULT_CLOUDFLARE_CHILD_PLACEMENT
    if (existing !== undefined && (
      existing.parentThread !== lineage.parent.thread ||
      Number(existing.depth) !== lineage.depth ||
      ((existing.state === "registered" || existing.placement !== undefined) && (existing.placement ?? null) !== placement)
    )) {
      throw new Error("a child thread already has different lineage")
    }
    await this.ensureThreadReady(target.thread, { kind: "child", parent: lineage.parent, child: childKeyOf(target.thread), placement,
      ...(lineage.maxDepth === undefined ? {} : { maxDepth: lineage.maxDepth }) })
    const stub = this.env.THREADS.getByName(threadObjectNameOf(target.actor, target.instance, target.thread))
    await stub.deliver(envelope)
  }

  async threadTree(bounds: TreeBounds = {}): Promise<ReadonlyArray<ActorThreadNode> | undefined> {
    const entries = (await this.threads()).filter((entry) => entry.state === "registered")
    return threadTreeOf(entries, bounds)
  }

  async alarm(): Promise<void> {
    const at = armAt(await this.ctx.storage.getAlarm(), Date.now(), this.alarmPolicy.recoveryDelayMillis)
    if (at !== null) await this.ctx.storage.setAlarm(at)
    await scheduler.wait(0)
    await this.reconcile()
    await this.synchronizeAlarm()
  }
}
