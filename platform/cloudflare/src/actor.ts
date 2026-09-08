import type { TreeBounds } from "@clavia/tardigrade-client/contract"
import { threadCreated } from "@clavia/tardigrade-core/interaction/relations"
import { childKeyOf } from "@clavia/tardigrade-core/actor/coordinate"
import { threadObjectNameOf } from "./transport/directory"
import { DurableObject } from "cloudflare:workers"
import { Clock, Effect, ManagedRuntime, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { publicThreadId } from "@clavia/tardigrade-host/thread-compat"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { EventLog, eventLogFrom } from "@clavia/tardigrade-core/log"
import { type ActorEnvelope } from "@clavia/tardigrade-core/interaction/envelope"
import { ActorInstanceId, isThreadAddress, type ThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { actorEventsOf, actorEventKeyOf, actorThreadsOf, type ActorThreadRecord, type ThreadRequested } from "@clavia/tardigrade-core/actor"
import { ThreadAllocator, allocateThread } from "@clavia/tardigrade-core/actor/allocation"
import { registeredThreadAllocator } from "@clavia/tardigrade-host/allocation"
import { sqlThreadDirectory } from "@clavia/tardigrade-host/allocation-sql"
import type { ThreadAllocation } from "@clavia/tardigrade-core/actor/allocation"
import { sameThreadAddress, type ChildPlacement } from "@clavia/tardigrade-core/interaction/relations"
import { effect, restingActor, settleActor } from "@clavia/tardigrade-core/runtime"
import { actorFromProjections } from "@clavia/tardigrade-core/runtime"
import { completeTransitionProjection } from "@clavia/tardigrade-core/transition"
import { alarmPolicyOf, armAt, scheduledAlarmAt, type AlarmPolicy } from "./alarm"
import { initializeCloudflareActorSchema, CloudflareEventStore } from "./storage"
import type { Env } from "./env"
import { mountedActor, deployed, nonNegativeInteger } from "./assembly"

export interface ActorThreadNode {
  readonly id: string
  readonly parent?: string
  readonly depth: number
  readonly placement?: ChildPlacement
  readonly children: ReadonlyArray<ActorThreadNode>
}

const registeredKeyOf = (thread: string): string => `thread:registered:${thread}`

const actorSupervisorOf = (
  env: Env,
  identity: { readonly actor: string; readonly instance: string }
) => actorFromProjections({
  transitions: [completeTransitionProjection((events) => {
    const actorEvents = actorEventsOf(events)
    const registered = new Set(actorEvents.flatMap((event) => event.type === "ThreadRegistered" ? [event.thread] : []))
    const registrations = actorEvents.flatMap((event) => {
      if (event.type !== "ThreadRequested" || registered.has(event.thread)) return []
      return [effect({
        key: registeredKeyOf(event.thread),
        input: event,
        act: (request) => Effect.gen(function* () {
          const registration = yield* Effect.promise(async () => {
            const stub = env.THREADS.getByName(threadObjectNameOf(identity.actor, identity.instance, request.thread))
            if (request.parentThread === undefined) {
              await stub.init(identity.actor, identity.instance, request.thread)
              await stub.initializeRoot()
              return {}
            }
            const created = await stub.commitCreation()
            return created === undefined ? undefined : created.placement === undefined ? {} : { placement: created.placement }
          })
          if (registration === undefined) return []
          return [{ type: "ThreadRegistered", thread: request.thread, ...registration, at: yield* Clock.currentTimeMillis }]
        })
      })]
    })
    return registrations
  })],
  keyOf: actorEventKeyOf
})

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
    const descendants: ActorThreadNode[] = []
    if ((maxDepth === undefined || level < maxDepth) && (maxNodes === undefined || built < maxNodes)) {
      for (const child of [...children.get(id) ?? []].sort()) {
        const result = node(child, next, level + 1)
        if (result === undefined) break
        descendants.push(result)
      }
    }
    return { ...entry, children: descendants }
  }
  const tree: ActorThreadNode[] = []
  for (const start of root === undefined ? roots.sort() : [root]) {
    const result = node(start, new Set(), 0)
    if (result === undefined) break
    tree.push(result)
  }
  // Partial reads cannot establish whether the full roster is connected (test/actor.workers.ts).
  if (root === undefined && maxDepth === undefined && maxNodes === undefined && visited.size !== entries.size) {
    throw new Error("thread tree contains an orphan or cycle")
  }
  return tree
}

// ActorDO reconciles one actor instance from its durable event log.
export class ActorDO extends DurableObject<Env> {
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
      (sql) => new CloudflareEventStore(sql, actorEventKeyOf)
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
    return restingActor(actorSupervisorOf(this.env, this.identity()), await this.events())
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
    const identity = this.identity()
    const store = await this.store()
    await this.database.runPromise(
      settleActor(actorSupervisorOf(this.env, identity)).pipe(
        Effect.provideService(EventLog, eventLogFrom(store))
      )
    )
    await this.ctx.storage.sync()
  }

  private async request(event: ThreadRequested): Promise<void> {
    await this.database.runPromise((await this.store()).append([event]))
    const at = armAt(await this.ctx.storage.getAlarm(), Date.now(), this.alarmPolicy.recoveryDelayMillis)
    if (at !== null) await this.ctx.storage.setAlarm(at)
    await scheduler.wait(0)
    await this.reconcile()
    await this.synchronizeAlarm()
  }

  async createThread(name?: string, options: { readonly key?: string; readonly parent?: string } = {}): Promise<ThreadAddress> {
    const identity = this.identity()
    if (name !== undefined && options.key !== undefined) throw new Error("named allocations do not accept a separate key")
    const key = name === undefined ? { key: options.key ?? crypto.randomUUID() } : {}
    if (options.parent !== undefined) {
      const parent = (await this.threads()).find((entry) => entry.thread === options.parent && entry.state === "registered")
      if (parent === undefined) throw new Error("parent thread does not exist")
      const source = { ...identity, thread: options.parent }
      const target = await this.allocateThread({ kind: "child", parent: source, child: childKeyOf(name ?? "unnamed"), ...key })
      const lineage = { parent: source, depth: Number(parent.depth) + 1 }
      await this.deliverChild({ link: { source, target }, lineage, event: threadCreated(target, lineage, Date.now()) })
      return target
    }
    const target = await this.allocateThread({ kind: "root", coordinate: { ...identity, thread: name ?? "" }, ...key })
    await this.initializeRootThread(target.thread)
    return target
  }

  async allocateThread(request: ThreadAllocation): Promise<ThreadAddress> {
    const identity = this.identity()
    const scope = request.kind === "root" ? request.coordinate : request.parent
    if (scope.actor !== identity.actor || scope.instance !== identity.instance) throw new Error("allocation requires the owning actor directory")
    const sql = await this.database.runPromise(SqliteClient.SqliteClient)
    const store = sqlThreadDirectory(sql, "events", (target, existingRoot) =>
      sql<{ parent: string | null }>`SELECT json_extract(event, '$.parentThread') AS parent FROM events
        WHERE json_extract(event, '$.type') = 'ThreadRequested' AND json_extract(event, '$.thread') = ${target.thread}`.pipe(
        Effect.map((rows) => rows.length > 0 && (!existingRoot || rows.some((row) => row.parent !== null))), Effect.orDie
      ))
    const target = await Effect.runPromise(allocateThread(request).pipe(Effect.provideService(
      ThreadAllocator, mountedActor?.threadAllocator ?? registeredThreadAllocator({
        get: (key) => Effect.promise(() => this.database.runPromise(store.get(key))),
        claim: (key, target, existingRoot, request) => Effect.promise(() => this.database.runPromise(store.claim(key, target, existingRoot, request)))
      }, mountedActor?.allocation)
    )))
    const at = armAt(await this.ctx.storage.getAlarm(), Date.now(), this.alarmPolicy.recoveryDelayMillis)
    if (at !== null) await this.ctx.storage.setAlarm(at)
    return target
  }

  async initializeRootThread(thread: string): Promise<void> {
    const identity = this.identity()
    const existing = (await this.threads()).find((entry) => entry.thread === thread)
    if (existing !== undefined && existing.parentThread !== undefined) {
      throw new Error("a child thread cannot be recreated as a root")
    }
    const stub = this.env.THREADS.getByName(threadObjectNameOf(identity.actor, identity.instance, thread))
    await stub.init(identity.actor, identity.instance, thread)
    await stub.initializeRoot()
    await this.request({ type: "ThreadRequested", thread, depth: 0, at: Date.now() })
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
    const placement = lineage.placement ?? null
    if (existing !== undefined && (
      existing.parentThread !== lineage.parent.thread ||
      Number(existing.depth) !== lineage.depth ||
      ((existing.state === "registered" || existing.placement !== undefined) && (existing.placement ?? null) !== placement)
    )) {
      throw new Error("a child thread already has different lineage")
    }
    const stub = this.env.THREADS.getByName(threadObjectNameOf(identity.actor, identity.instance, target.thread))
    await stub.init(identity.actor, identity.instance, target.thread)
    // deliverChild crosses a delivery to a child thread that is already registered as a plain
    // deliver. A staged creation would leave the message unwoken, because the duplicate
    // creation request commits nothing to wake it (actor.workers.ts, "a re-delivery to a
    // registered child delivers instead of recreating").
    if (existing?.state === "registered") {
      await stub.deliver(envelope)
      return
    }
    await stub.stageCreation(envelope)
    await this.request({
      type: "ThreadRequested",
      thread: target.thread,
      parentThread: lineage.parent.thread,
      depth: lineage.depth,
      ...(placement === null ? {} : { placement }),
      at: Date.now()
    })
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
