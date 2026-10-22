import { isDeepStrictEqual } from "node:util"
import { Effect, Random, Schema, Semaphore } from "effect"
import { RuntimeError, type ThreadCoordinate, type ThreadRequest } from "@clavia/tardigrade-core"
import { Allocation, SupervisorEvent, type ThreadAllocation } from "@clavia/tardigrade-core/services/supervisor/graph"
import type { SupervisorStore } from "@clavia/tardigrade-core/runtime/stores/supervisor"
import type { RegistrationResult } from "@clavia/tardigrade-core/services/supervisor/registration"
import { decodeSqlJournalRecord } from "../shared/journal-records"

export const DEFAULT_DIRECTORY_PAGE_SIZE = 16
export interface DirectoryRow { readonly thread: string; readonly name: string; readonly parent: string; readonly allocation: string; readonly status: "requested" | "registered" | "failed"; readonly reason: string | null; readonly generation: number; readonly origin: number }
export const registrationObjectName = (coordinate: ThreadCoordinate) => JSON.stringify([coordinate.actor, coordinate.instance, "registration", coordinate.thread])

// indexedDirectory projects immutable registration records without opening their actor runtime (test/workerd/thread-layout.workers.ts).
export function indexedDirectory(options: {
  readonly storage: DurableObjectStorage
  readonly actor: string
  readonly instance: string
  readonly pageSize?: number
  readonly generateName?: () => string
  readonly validateInitialState: (state: NonNullable<ThreadRequest["initialState"]>) => Effect.Effect<void, Error>
  readonly provision: (allocation: ThreadAllocation, generation: number) => Effect.Effect<void, Error>
  readonly commit: <Value>(work: () => Value, admission: boolean) => Effect.Effect<Value, Error>
}) {
  const { storage, actor, instance } = options
  const pageSize = options.pageSize ?? DEFAULT_DIRECTORY_PAGE_SIZE
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RuntimeError("Directory pageSize must be a positive safe integer")
  const sql = <Row extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]) => storage.sql.exec<Row>(query, ...bindings).toArray()
  storage.transactionSync(() => {
    sql("CREATE TABLE IF NOT EXISTS actor_directory(thread TEXT PRIMARY KEY,name TEXT NOT NULL,parent TEXT NOT NULL,allocation TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,generation INTEGER NOT NULL,origin INTEGER NOT NULL,UNIQUE(parent,name)) WITHOUT ROWID")
    sql("CREATE INDEX IF NOT EXISTS actor_directory_pending ON actor_directory(thread) WHERE status='requested'")
    sql("CREATE TABLE IF NOT EXISTS actor_directory_projection(id INTEGER PRIMARY KEY CHECK(id=1),cursor INTEGER NOT NULL,revision INTEGER NOT NULL) WITHOUT ROWID")
    sql("INSERT INTO actor_directory_projection VALUES(1,-1,0) ON CONFLICT(id) DO NOTHING")
  })
  const row = (thread: string) => sql<DirectoryRow & Record<string, SqlStorageValue>>("SELECT * FROM actor_directory WHERE thread=?", thread)[0]
  const observers = new Set<() => void>()
  const commit: typeof options.commit = (work, admission) => options.commit(work, admission).pipe(Effect.tap(() => Effect.sync(() => { for (const listener of observers) listener() })))
  const getThreads = (): ReturnType<SupervisorStore["threads"]["get"]> => sql<DirectoryRow & Record<string, SqlStorageValue>>("SELECT * FROM actor_directory ORDER BY thread").map(entry => ({ ...allocation(entry), origin: entry.origin, status: entry.status, ...(entry.reason === null ? {} : { reason: entry.reason }) }))
  const allocation = (entry: DirectoryRow) => Schema.decodeUnknownSync(Allocation)(JSON.parse(entry.allocation))
  const revision = () => sql<{ revision: number }>("SELECT revision FROM actor_directory_projection WHERE id=1")[0]!.revision
  const advance = () => sql("UPDATE actor_directory_projection SET revision=revision+1 WHERE id=1")
  const project = (event: SupervisorEvent, origin: number, legacy = false) => {
    if (event.type === "ThreadRequested") {
      const next = event.allocation
      if (next.coordinate.actor !== actor || next.coordinate.instance !== instance) throw new RuntimeError("Supervisor instance mismatch")
      const previous = row(next.coordinate.thread)
      if (previous && (previous.status !== "failed" || !isDeepStrictEqual(allocation(previous), next))) throw new RuntimeError("Duplicate thread allocation")
      const parent = next.parent === null ? undefined : row(next.parent)
      if (next.parent !== null && parent?.status !== "registered") throw new RuntimeError("Unknown parent thread")
      if (next.depth !== (parent ? allocation(parent).depth + 1 : 0)) throw new RuntimeError("Invalid thread depth")
      sql("INSERT INTO actor_directory(thread,name,parent,allocation,status,generation,origin) VALUES(?,?,?,?,'requested',0,?) ON CONFLICT(thread) DO UPDATE SET status='requested',reason=NULL,origin=excluded.origin", next.coordinate.thread, next.name, next.parent ?? "", JSON.stringify(next), origin)
    } else {
      const previous = row(event.coordinate.thread)
      // Legacy late completions require native provisioning to verify the original allocation (thread-layout.workers.ts).
      if (legacy && event.type === "ThreadRegistered" && previous?.status === "failed" && event.coordinate.actor === actor && event.coordinate.instance === instance) {
        sql("UPDATE actor_directory SET status='requested',reason=NULL,generation=generation+1 WHERE thread=?", previous.thread)
        return
      }
      if (!previous || previous.status !== "requested" || event.coordinate.actor !== actor || event.coordinate.instance !== instance) throw new RuntimeError("Unknown thread registration")
      sql("UPDATE actor_directory SET status=?,reason=? WHERE thread=?", event.type === "ThreadRegistered" ? "registered" : "failed", event.type === "ThreadFailed" ? event.reason : null, event.coordinate.thread)
    }
  }
  const ready = Effect.runSync(Effect.cached(Effect.gen(function* () {
    if (!sql("SELECT name FROM sqlite_master WHERE type='table' AND name='experimental_events'").length) return
    const key = JSON.stringify([actor, instance, "supervisor"])
    while (true) {
      const cursor = sql<{ cursor: number }>("SELECT cursor FROM actor_directory_projection WHERE id=1")[0]!.cursor
      const records = sql<{ seq: number; type: string | null; chunks: number | null }>("SELECT seq,json_extract(event,'$.event.type') AS type,json_extract(event,'$.chunkCount') AS chunks FROM experimental_events WHERE actor=? AND seq>? ORDER BY seq LIMIT ?", key, cursor, pageSize)
      if (!records.length) break
      yield* commit(() => {
        for (const [index, record] of records.entries()) {
          if (record.seq !== cursor + index + 1) throw new RuntimeError("Invalid journal sequence")
          if (record.chunks !== null || ["ThreadRequested", "ThreadRegistered", "ThreadFailed"].includes(record.type ?? "")) {
            const text = sql<{ event: string }>("SELECT event FROM experimental_events WHERE actor=? AND seq=?", key, record.seq)[0]!.event
            const decoded = decodeSqlJournalRecord<SupervisorEvent>(text, () => sql<{ ordinal: number; payload: ArrayBuffer }>("SELECT ordinal,payload FROM experimental_event_chunks WHERE actor=? AND seq=? ORDER BY ordinal", key, record.seq))
            if ("type" in decoded.event && ["ThreadRequested", "ThreadRegistered", "ThreadFailed"].includes(String(decoded.event.type))) project(Schema.decodeUnknownSync(SupervisorEvent)(decoded.event), record.seq, true)
          }
        }
        sql("UPDATE actor_directory_projection SET cursor=?,revision=MAX(revision,?) WHERE id=1", records.at(-1)!.seq, records.at(-1)!.seq + 1)
      }, false)
      yield* Effect.yieldNow
    }
    yield* Effect.logInfo("Actor directory projected", { ...sql("SELECT COUNT(*) registrations,COALESCE(SUM(length(CAST(allocation AS BLOB))),0) allocationBytes FROM actor_directory")[0], ...sql("SELECT COUNT(*) legacyRecords,COALESCE(SUM(length(CAST(event AS BLOB))),0) legacyBytes FROM experimental_events WHERE actor=?", key)[0] })
  })))
  const lock = Semaphore.makeUnsafe(1)
  const randomName = Effect.gen(function* () { return `${yield* Random.nextInt}-${yield* Random.nextInt}` })
  const allocate = (request: ThreadRequest) => ready.pipe(Effect.andThen(lock.withPermit(Effect.gen(function* () {
    if (request.instance !== instance) return yield* Effect.fail(new RuntimeError("Actor instance differs from directory"))
    if (request.initialState !== undefined) yield* options.validateInitialState(request.initialState)
    if (request.placement !== undefined && request.placement !== "independent") return yield* Effect.fail(new RuntimeError("Unsupported child placement"))
    if (request.parent && (request.parent.actor !== actor || request.parent.instance !== instance)) return yield* Effect.fail(new RuntimeError("Parent belongs to another actor instance"))
    const parent = request.parent ? row(request.parent.thread) : undefined
    if (request.parent && parent?.status !== "registered") return yield* Effect.fail(new RuntimeError("Unknown parent thread"))
    const name = request.name ?? (options.generateName ? yield* Effect.try({ try: options.generateName, catch: RuntimeError.from }) : yield* randomName)
    if (!name || name.includes("/")) return yield* Effect.fail(new RuntimeError("Thread name must be nonempty and contain no slash"))
    const existing = sql<DirectoryRow & Record<string, SqlStorageValue>>("SELECT * FROM actor_directory WHERE parent=? AND name=?", request.parent?.thread ?? "", name)[0]
    if (existing) {
      const saved = allocation(existing)
      if (request.initialState !== undefined && !isDeepStrictEqual(saved.initialState, request.initialState)) return yield* Effect.fail(new RuntimeError("Named thread already has different initial state"))
      if (request.placement !== undefined && saved.placement !== request.placement) return yield* Effect.fail(new RuntimeError("Named thread already has different placement"))
      if (request.name === undefined) return yield* Effect.fail(new RuntimeError("Generated thread name already exists; supply a different name or generator"))
      if (existing.status === "failed") yield* commit(() => { sql("UPDATE actor_directory SET status='requested',reason=NULL,generation=generation+1 WHERE thread=?", existing.thread); advance() }, true)
      return row(existing.thread)!
    }
    const thread = row(name) ? `${name}-${yield* randomName}` : name
    if (row(thread)) return yield* Effect.fail(new RuntimeError("Thread identity collision"))
    const next: ThreadAllocation = { coordinate: { actor, instance, thread }, name, parent: request.parent?.thread ?? null, depth: parent ? allocation(parent).depth + 1 : 0, placement: "independent", ...(request.initialState === undefined ? {} : { initialState: request.initialState }) }
    yield* commit(() => { project({ type: "ThreadRequested", allocation: next }, revision()); advance() }, true)
    return row(thread)!
  }))), Effect.flatMap(entry => Effect.gen(function* () {
    if (entry.status !== "registered") yield* options.provision(allocation(entry), entry.generation)
    const completed = row(entry.thread)!
    if (completed.status !== "registered") return yield* Effect.fail(new RuntimeError(completed.reason ?? "Thread provisioning did not complete"))
    return allocation(completed).coordinate
  })))
  const complete = (result: RegistrationResult, generation: number) => ready.pipe(Effect.andThen(commit(() => {
    const previous = row(result.allocation.coordinate.thread)
    if (!previous || !isDeepStrictEqual(allocation(previous), result.allocation)) throw new RuntimeError("Registration identity mismatch")
    if (generation !== previous.generation) throw new RuntimeError("Registration generation mismatch")
    if (previous.status !== "requested") {
      if (previous.status !== result.status || previous.reason !== (result.reason ?? null)) throw new RuntimeError("Registration outcome mismatch")
      return
    }
    sql("UPDATE actor_directory SET status=?,reason=? WHERE thread=?", result.status, result.reason ?? null, previous.thread)
    advance()
  }, false)))
  return { allocate, complete, ready, revision,
    lookup: (coordinate: ThreadCoordinate) => ready.pipe(Effect.andThen(Effect.try({ try: () => {
      if (coordinate.actor !== actor || coordinate.instance !== instance) throw new RuntimeError("Actor instance differs from directory")
      const found = row(coordinate.thread)
      if (!found || found.status !== "registered") return undefined
      const saved = allocation(found)
      if (saved.placement !== "independent") throw new RuntimeError("Stored colocated threads require migration before independent routing")
      return saved.coordinate
    }, catch: RuntimeError.from }))),
    recover: ready.pipe(Effect.andThen(Effect.gen(function* () {
      let cursor = ""
      while (true) {
        const pending = sql<DirectoryRow & Record<string, SqlStorageValue>>("SELECT * FROM actor_directory WHERE status='requested' AND thread>? ORDER BY thread LIMIT ?", cursor, pageSize)
        if (!pending.length) break
        yield* Effect.forEach(pending, entry => options.provision(allocation(entry), entry.generation), { concurrency: 1, discard: true })
        cursor = pending.at(-1)!.thread
      }
      return { progressCursor: revision(), status: sql("SELECT thread FROM actor_directory WHERE status='requested' LIMIT 1").length ? "pending" as const : "settled" as const }
    }))),
    // store retains the explicit full inspection surface; dispatch uses point reads.
    store: () => ready.pipe(Effect.as({ threads: {
      get: getThreads,
      subscribe: (listener: Parameters<SupervisorStore["threads"]["subscribe"]>[0]) => {
        let previous = getThreads()
        const notify = () => { const before = previous; previous = getThreads(); listener(previous, before) }
        observers.add(notify)
        return () => { observers.delete(notify) }
      },
    } })),
    invalidate: () => Effect.void, close: Effect.void,
  }
}
