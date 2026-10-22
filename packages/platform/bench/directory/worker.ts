import { createHash } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { defineActor, durableAtom, effectAtom, event, type InitialState, type ThreadCoordinate, type ThreadCreated, type ThreadRequest } from "@clavia/tardigrade-core"
import { createActorWorker, cloudflareThreadName } from "../../src/cloudflare"
import { DIRECTORY_ORACLE_ACTOR, DIRECTORY_ORACLE_INSTANCE, type JournalStats } from "./config"

const Changed = event({ type: "Changed", value: Schema.Int })
const value = durableAtom({ name: "oracle.value", input: Changed, schema: Schema.Int, initial: 0, reduce: (_, event) => event.value })
const payload = durableAtom({ name: "oracle.payload", input: Changed, schema: Schema.String, initial: "", reduce: state => state })
const actor = defineActor(DIRECTORY_ORACLE_ACTOR, Effect.sync(() => ({
  schema: Changed,
  atom: effectAtom(get => ({ view: get(value), events: {}, acts: {} })),
})))
const worker = createActorWorker({ actor, actorContext: Context.pick(), initialStateAtoms: [value, payload], services: () => Layer.empty })

export class DirectoryDO extends worker.ActorObject {
  private control: unknown

  seed(start: number, count: number, payloadBytes: number, pending: boolean) {
    const instance = DIRECTORY_ORACLE_INSTANCE
    const key = JSON.stringify([DIRECTORY_ORACLE_ACTOR, instance, "supervisor"])
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS experimental_events(actor TEXT NOT NULL,seq INTEGER NOT NULL,event TEXT NOT NULL,PRIMARY KEY(actor,seq)) WITHOUT ROWID")
    let seq = this.ctx.storage.sql.exec<{ position: number }>("SELECT COALESCE(MAX(seq)+1,0) AS position FROM experimental_events WHERE actor=?", key).one().position
    const padding = "x".repeat(payloadBytes)
    this.ctx.storage.transactionSync(() => {
      for (let index = start; index < start + count; index++) {
        const thread = `${pending ? "pending" : "historical"}-${index}`
        const coordinate = { actor: DIRECTORY_ORACLE_ACTOR, instance, thread }
        const allocation = { coordinate, name: thread, parent: null, depth: 0, placement: "independent", initialState: { "oracle.value": 7, "oracle.payload": padding } }
        this.ctx.storage.sql.exec("INSERT INTO experimental_events VALUES(?,?,?)", key, seq++, JSON.stringify({ event: { type: "ThreadRequested", allocation }, recordedAt: index }))
        if (!pending) this.ctx.storage.sql.exec("INSERT INTO experimental_events VALUES(?,?,?)", key, seq++, JSON.stringify({ event: { type: "ThreadRegistered", coordinate }, recordedAt: index }))
      }
    })
    return { position: seq }
  }

  async seeded() {
    await this.ctx.storage.put("tardie:actor:instance", DIRECTORY_ORACLE_INSTANCE)
    await this.ctx.storage.sync()
  }

  stats(prefix: number, pageSize: number): JournalStats {
    const key = JSON.stringify([DIRECTORY_ORACLE_ACTOR, DIRECTORY_ORACLE_INSTANCE, "supervisor"])
    const hash = createHash("sha256")
    let records = 0
    let bytes = 0
    while (records < prefix) {
      const rows = this.ctx.storage.sql.exec<{ seq: number; event: string }>("SELECT seq,event FROM experimental_events WHERE actor=? AND seq>=? AND seq<? ORDER BY seq LIMIT ?", key, records, prefix, pageSize).toArray()
      if (!rows.length) throw new Error("Seeded journal prefix is missing")
      for (const row of rows) {
        if (row.seq !== records) throw new Error("Seeded journal prefix is discontinuous")
        hash.update(`${row.seq}:`).update(row.event).update("\n")
        bytes += new TextEncoder().encode(row.event).byteLength
        records++
      }
    }
    return { records, bytes, digest: hash.digest("hex") }
  }

  materializeControl() {
    const key = JSON.stringify([DIRECTORY_ORACLE_ACTOR, DIRECTORY_ORACLE_INSTANCE, "supervisor"])
    const records = this.ctx.storage.sql.exec<{ event: string }>("SELECT event FROM experimental_events WHERE actor=? ORDER BY seq", key).toArray().map(row => JSON.parse(row.event) as { event: { type: string; allocation?: object } })
    const allocations = records.flatMap(record => record.event.type === "ThreadRequested" ? [record.event.allocation!] : [])
    this.control = allocations
    return { allocations: allocations.length, retained: this.control !== undefined }
  }
}

export class ThreadDO extends worker.ThreadObject {
  async failNextProvisions(count: number) { await this.ctx.storage.put("oracle:failures", count) }
  async provisionCalls() { return (await this.ctx.storage.get<number>("oracle:provisions")) ?? 0 }
  initialValue() {
    const row = this.ctx.storage.sql.exec<{ event: string }>("SELECT event FROM experimental_events WHERE json_extract(event,'$.event.type')='StateInitialised' ORDER BY seq LIMIT 1").toArray()[0]
    return row ? (JSON.parse(row.event) as { event: { initialState: Record<string, unknown> } }).event.initialState["oracle.value"] : null
  }
  override async provision(created: ThreadCreated, initialState?: InitialState) {
    await this.ctx.storage.put("oracle:provisions", (await this.provisionCalls()) + 1)
    const failures = (await this.ctx.storage.get<number>("oracle:failures")) ?? 0
    if (failures) {
      await this.ctx.storage.put("oracle:failures", failures - 1)
      throw new Error("Injected transient provisioning failure")
    }
    return super.provision(created, initialState)
  }
}

interface Env {
  readonly ACTORS: DurableObjectNamespace<DirectoryDO>
  readonly THREADS: DurableObjectNamespace<ThreadDO>
}

export default { async fetch(request: Request, env: Env) {
  const url = new URL(request.url)
  if (url.pathname === "/oracle/ready") return Response.json({ ready: true })
  const directory = env.ACTORS.getByName(DIRECTORY_ORACLE_INSTANCE)
  const coordinate = (thread: string): ThreadCoordinate => ({ actor: DIRECTORY_ORACLE_ACTOR, instance: DIRECTORY_ORACLE_INSTANCE, thread })
  const thread = url.searchParams.get("thread") ?? ""
  switch (url.pathname) {
    case "/oracle/seed": {
      const body = await request.json() as { start: number; count: number; payloadBytes: number; pending: boolean }
      return Response.json(await directory.seed(body.start, body.count, body.payloadBytes, body.pending))
    }
    case "/oracle/seeded": await directory.seeded(); return Response.json(true)
    case "/oracle/stats": return Response.json(await directory.stats(Number(url.searchParams.get("prefix")), Number(url.searchParams.get("pageSize"))))
    case "/oracle/lookup": return Response.json(await directory.lookup(coordinate(thread)) ?? null)
    case "/oracle/allocate": return Response.json(await directory.allocate(await request.json() as ThreadRequest))
    case "/oracle/fail": await env.THREADS.getByName(cloudflareThreadName(coordinate(thread))).failNextProvisions(1); return Response.json(true)
    case "/oracle/calls": return Response.json(await env.THREADS.getByName(cloudflareThreadName(coordinate(thread))).provisionCalls())
    case "/oracle/value": return Response.json(await env.THREADS.getByName(cloudflareThreadName(coordinate(thread))).initialValue())
    case "/oracle/control": return Response.json(await directory.materializeControl())
    default: return new Response("Not found", { status: 404 })
  }
} }
