import { DurableObject } from "cloudflare:workers"
import { Context, Deferred, Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { act, appendOnly, createActorStore, defineActor, durableAtom, effectAtom, effectKey, keyValue, RuntimeError, type EffectRef } from "@clavia/tardigrade-core"
import { cloudflareJournal } from "../../../src/cloudflare"
import { effectServiceClient } from "../effect-service"
import { waitFor } from "../wait"
import fixture from "../migration/050-snapshot.json"

const Event = Schema.Union([Schema.Struct({ type: Schema.Literal("Added"), text: Schema.String }), Schema.Struct({ type: Schema.Literal("Started") }), Schema.Struct({ type: Schema.Literal("Finished") })])
const Job = act({ name: "migration-job", input: Schema.Struct({ messages: Schema.Array(Schema.String), token: Schema.String }), success: Schema.Int, failure: Schema.String })
type Call = { readonly instance: string; readonly ref: EffectRef; readonly input: { readonly messages: readonly string[]; readonly token: string } }
type SqlValue = string | number | null | { readonly base64: string }
interface SnapshotTable { readonly name: string; readonly sql: string; readonly rows: readonly Readonly<Record<string, SqlValue>>[] }
const tables = fixture.tables as readonly SnapshotTable[]
const oldTables = ["checkpoint", "checkpoint_chunks", "checkpoint_trees", "effect_inputs", "effect_input_chunks", "grove_nodes", "grove_chunks", "grove_owners"]

// MigrationDO restores a frozen 0.50 database before opening the current runtime (workerd/migration.workers.ts).
export class MigrationDO extends DurableObject<{ EFFECT_SERVICE: { getByName(name: string): { fetch(request: Request): Promise<Response> } } }> {
  private readonly instance = crypto.randomUUID()
  private readonly external = effectServiceClient(request => this.env.EFFECT_SERVICE.getByName(this.ctx.id.toString()).fetch(request))
  private readonly completion = Deferred.makeUnsafe<void>()
  private live: ReturnType<MigrationDO["open"]> | undefined
  private journal: ReturnType<typeof cloudflareJournal<typeof Event.Type>> | undefined

  async seed() {
    this.ctx.storage.transactionSync(() => {
      for (const table of tables) this.ctx.storage.sql.exec(table.sql)
      for (const index of fixture.indexes) this.ctx.storage.sql.exec(index.sql)
      for (const table of [...tables].sort((a, b) => Number(b.name === "experimental_events") - Number(a.name === "experimental_events"))) for (const row of table.rows) {
        const values = Object.values(row).map(value => typeof value === "object" && value !== null ? Uint8Array.from(atob(value.base64), character => character.charCodeAt(0)) : value)
        this.ctx.storage.sql.exec(`INSERT INTO ${table.name} (${Object.keys(row).join(",")}) VALUES (${values.map(() => "?").join(",")})`, ...values)
      }
    })
    await this.ctx.storage.put({
      ["tardie:watchdog:" + fixture.recovery.key]: fixture.recovery.watchdog,
      ["tardie:scheduler:" + fixture.recovery.wake.id]: fixture.recovery.wake,
      "tardie:scheduler-generation": fixture.recovery.generation,
    })
    await this.ctx.storage.setAlarm(fixture.recovery.dueAt)
    await this.external.configure({ holdExecution: true, runDurationMs: 5 })
    await this.external.submit(fixture.effectKey, fixture.acceptedInput)
    await this.ctx.storage.sync()
    return this.inspectSource()
  }

  private open() {
    const journal = this.journal = cloudflareJournal<typeof Event.Type>(this.ctx.storage, "events", { checkpointChunkBytes: 127, checkpointTree: { collectEvery: 1, cacheBytes: 0 } })
    const actor = defineActor("migration", Effect.sync(() => {
      const history = durableAtom({ name: "migration.history", schema: appendOnly(Schema.Array(Schema.String)), input: Event, initial: [], reduce: (state, event) => event.type === "Added" ? state.append([], [event.text]) : state })
      const control = durableAtom({ name: "migration.control", schema: keyValue(Schema.Boolean), input: Event, initial: { started: false, done: false }, reduce: (state, event) => event.type === "Started" ? state.set(["started"], true) : event.type === "Finished" ? state.set(["done"], true) : state })
      let request: ReturnType<typeof Job.requestTree> | undefined
      return { schema: Event, atom: effectAtom(get => {
        const messages = get(history), state = get(control)
        const started = state.read(["started"]), done = state.read(["done"])
        if (started && !request) request = Job.requestTree({ origin: 1, input: { messages: messages.selectEach([], [], { start: 0, end: messages.length([]) }), token: "new proposal must not replace accepted input" }, onSettled: () => [{ type: "Finished" }] })
        return { view: { messages: messages.read([]), started, done }, events: {}, acts: started && !done ? { job: request! } : {} }
      }) }
    }))
    return Effect.runPromise(createActorStore({ actor, journal, checkpoint: { mode: "manual" }, attemptTimeoutMs: null, actorContext: Context.pick(), services: () => Job.layer((input, { ref }) => Effect.gen({ self: this }, function* () {
      yield* Effect.tryPromise({ try: async () => {
        const calls = await this.ctx.storage.get<readonly Call[]>("migration:calls") ?? []
        await this.ctx.storage.put("migration:calls", [...calls, { instance: this.instance, ref, input }])
        await this.external.submit(effectKey(ref), input)
      }, catch: RuntimeError.from })
      yield* Deferred.await(this.completion)
      return input.messages.length
    }).pipe(Effect.mapError(String))) }))
  }

  async attemptUpgrade(): Promise<{ readonly error: string | null }> {
    try { await this.inspect(); return { error: null } } catch (cause) { return { error: String(cause) } }
  }

  async inspect() {
    const store = await (this.live ??= this.open())
    return {
      instance: this.instance, view: store.getState().view,
      inputs: await Effect.runPromise(this.journal!.readInputs),
      calls: await this.ctx.storage.get<readonly Call[]>("migration:calls") ?? [],
      job: await this.external.job(fixture.effectKey),
      source: this.inspectSource(), recovery: await this.inspectRecovery(),
    }
  }

  async inspectRecovery() {
    const sql = this.ctx.storage.sql
    const read = (table: string) => sql.exec("SELECT name FROM sqlite_master WHERE name=?", table).toArray().length
      ? sql.exec<{ id: string; entry: string }>(`SELECT id,entry FROM ${table} ORDER BY id`).toArray() : []
    return {
      legacy: [...await this.ctx.storage.list({ prefix: "tardie:" })].map(([key, value]) => [key, JSON.stringify(value)]),
      alarm: await this.ctx.storage.getAlarm(),
      wakes: read("scheduled_wakes"), watchdog: read("watchdogs"),
      generation: sql.exec("SELECT name FROM sqlite_master WHERE name='scheduler_generation'").toArray().length
        ? sql.exec<{ id: number; value: number }>("SELECT id,value FROM scheduler_generation ORDER BY id").toArray() : [],
    }
  }

  inspectSource() {
    const sql = this.ctx.storage.sql
    const normalize = (row: Record<string, unknown>): Record<string, SqlValue> => Object.fromEntries(Object.entries(row).map(([key, value]) => {
      if (value instanceof ArrayBuffer || value instanceof Uint8Array) return [key, { base64: Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value).toString("base64") }]
      if (value === null || typeof value === "string" || typeof value === "number") return [key, value]
      throw new Error("Unexpected SQLite fixture value")
    }))
    const rows = (table: string) => sql.exec(`SELECT * FROM ${table} ORDER BY ${table === "experimental_events" ? "actor,seq" : table === "experimental_event_chunks" ? "actor,seq,ordinal" : "actor,id"}`).toArray().map(normalize)
    const events = rows("experimental_events"), chunks = rows("experimental_event_chunks"), receipts = rows("experimental_messages")
    return {
      schema: sql.exec<{ name: string; sql: string }>("SELECT name,sql FROM sqlite_master WHERE name IN ('experimental_events','experimental_event_chunks','experimental_messages','experimental_thread_versions') ORDER BY name").toArray(),
      materialDigest: createHash("sha256").update(JSON.stringify(oldTables.map(table => [table, sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).toArray().length ? sql.exec(`SELECT * FROM ${table}`).toArray().map(normalize) : []]))).digest("hex"),
      digest: createHash("sha256").update(JSON.stringify({ events, chunks, receipts })).digest("hex"),
      events, chunks, receipts,
      materials: Object.fromEntries(oldTables.map(table => [table, sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).toArray().length ? sql.exec<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`).one().n : 0])),
      nativeOwners: sql.exec("SELECT name FROM sqlite_master WHERE name='grove_value_owners'").toArray().length ? sql.exec<{ scope: string; name: string; reference: string; root: string }>("SELECT * FROM grove_value_owners ORDER BY scope,name").toArray() : [],
    }
  }

  async finish() {
    const store = await (this.live ??= this.open())
    await this.external.configure({ holdExecution: false })
    await waitFor(() => this.external.job(fixture.effectKey), job => job?.status === "completed")
    await Effect.runPromise(Deferred.succeed(this.completion, undefined))
    await Effect.runPromise(store.wait)
    await Effect.runPromise(store.checkpoint)
    await Effect.runPromise(this.journal!.collect)
    return this.inspect()
  }

  failCleanup() { this.ctx.storage.sql.exec("CREATE TRIGGER migration_cleanup_fault BEFORE DELETE ON checkpoint_trees BEGIN SELECT RAISE(ABORT,'migration cleanup fault'); END") }
  allowCleanup() { this.ctx.storage.sql.exec("DROP TRIGGER migration_cleanup_fault") }
  abort() { this.ctx.abort("Migration fixture reset") }
}
