import type { SupervisorEvent } from "@clavia/tardigrade-core/services/supervisor/graph"
import { Context, Effect, Layer, Schema } from "effect"
import { actorMethod, createSupervisor, defineActor, durableAtom, effectAtom, event, type InitialState, type ThreadCreated } from "@clavia/tardigrade-core"
import { createActorWorker, cloudflareThreadName, cloudflareJournal } from "../../../src/cloudflare"
const Changed = event({ type: "Changed", value: Schema.Int })
const value = durableAtom({ name: "value", input: Changed, schema: Schema.Int, initial: 0, reduce: (_, event) => event.value })
const retained = durableAtom({ name: "retained", input: Changed, schema: Schema.String, initial: "", reduce: state => state })
const actor = defineActor("directory-fixture", Effect.sync(() => ({ schema: Changed, atom: effectAtom(get => ({ view: get(value), events: {}, acts: {} })), methods: {
  read: actorMethod({ inputSchema: Schema.Null, outputSchema: Schema.Int, onReceive: Changed.from(() => ({ value: 42 })), result: (_, get) => ({ status: "completed", output: get(value) }) }),
} })))
const worker = createActorWorker({ actor, actorContext: Context.pick(), initialStateAtoms: [value, retained], watchdog: { policy: { keepAliveIntervalMs: 20, retryIntervalMs: 20 } }, services: () => Layer.empty })
type Env = { ACTORS: DurableObjectNamespace<DirectoryDO>; THREADS: DurableObjectNamespace<ThreadDO> }
export class DirectoryDO extends worker.ActorObject {
  private old: ReturnType<typeof createSupervisor> | undefined
  async seed(start: number, count: number, pending = false) {
    const instance = this.ctx.id.name!
    const key = JSON.stringify([actor.actorName, instance, "supervisor"])
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS experimental_events(actor TEXT NOT NULL,seq INTEGER NOT NULL,event TEXT NOT NULL,PRIMARY KEY(actor,seq)) WITHOUT ROWID")
    let seq = this.ctx.storage.sql.exec<{ seq: number }>("SELECT COALESCE(MAX(seq)+1,0) seq FROM experimental_events WHERE actor=?", key).one().seq
    const padding = "x".repeat(96 * 1024)
    this.ctx.storage.transactionSync(() => {
      for (let index = start; index < start + count; index++) {
        const thread = `${pending ? "pending" : "historical"}-${index}`
        const coordinate = { actor: actor.actorName, instance, thread }
        const allocation = { coordinate, name: thread, parent: null, depth: 0, placement: "independent", initialState: pending ? { value: 7 } : { value: 7, retained: padding } }
        this.ctx.storage.sql.exec("INSERT INTO experimental_events VALUES(?,?,?)", key, seq++, JSON.stringify({ event: { type: "ThreadRequested", allocation }, recordedAt: Date.now() }))
        if (!pending) this.ctx.storage.sql.exec("INSERT INTO experimental_events VALUES(?,?,?)", key, seq++, JSON.stringify({ event: { type: "ThreadRegistered", coordinate }, recordedAt: Date.now() }))
      }
    })
    await this.ctx.storage.put("tardie:actor:instance", instance)
    return this.stats()
  }
  async recoverLegacy() { await this.alarm() }
  stats() { return this.ctx.storage.sql.exec<{ bytes: number; records: number }>("SELECT COALESCE(SUM(length(CAST(event AS BLOB))),0) bytes,COUNT(*) records FROM experimental_events").one() }
  async oldLookup() {
    const instance = this.ctx.id.name!
    const journal = cloudflareJournal<SupervisorEvent>(this.ctx.storage, JSON.stringify([actor.actorName, instance, "supervisor"]))
    this.old = createSupervisor({ actor: actor.actorName, journal: () => journal, run: work => work, defaultChildPlacement: "independent", supportedChildPlacements: ["independent"], provision: () => Effect.void })
    return Effect.runPromise(this.old.lookup({ actor: actor.actorName, instance, thread: "historical-0" }))
  }
}
export class ThreadDO extends worker.ThreadObject {
  private calls = 0
  override async provision(created: ThreadCreated, state?: InitialState) { this.calls++; return super.provision(created, state) }
  provisionCalls() { return this.calls }
}
export default { async fetch(request: Request, env: Env) {
  const url = new URL(request.url)
  const directory = env.ACTORS.getByName("memory")
  if (url.pathname === "/seed") return Response.json(await directory.seed(Number(url.searchParams.get("start")), Number(url.searchParams.get("count")), url.searchParams.has("pending")))
  if (url.pathname === "/recover") { await directory.recoverLegacy(); return Response.json(true) }
  if (url.pathname === "/stats") return Response.json(await directory.stats())
  if (url.pathname === "/old") return Response.json(await directory.oldLookup())
  if (url.pathname === "/lookup") return Response.json(await directory.lookup({ actor: actor.actorName, instance: "memory", thread: url.searchParams.get("thread")! }) ?? null)
  if (url.pathname === "/calls") return Response.json(await env.THREADS.getByName(cloudflareThreadName({ actor: actor.actorName, instance: "memory", thread: url.searchParams.get("thread")! })).provisionCalls())
  if (url.pathname === "/reopen") { await directory.dispose(); return new Response("closed") }
  return worker.fetch(request, env)
} }
