import { expect, test } from "bun:test"
import fc from "fast-check"
import { Database } from "bun:sqlite"
import { Context, Effect, Schema } from "effect"
import { act, atom, createStore, EventLog, defineActor, effectAtom, createActorStore } from "@clavia/tardigrade-core"
import { usdSpend } from "@clavia/tardigrade-agent"
import type { Event } from "@clavia/tardigrade-agent/contracts/events"
import { synchronousJournal } from "../../src/shared/synchronous-journal"
import { actorProperties } from "../properties/integration"
import { withSqlite } from "../fixtures/bun/sqlite"

test("standalone exported-event projections price finished agent turns without a host", () => {
  const prices = fc.array(fc.array(fc.option(fc.integer({ min: 0, max: 1000 }), { nil: null }), { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 5 })
  fc.assert(fc.property(prices, turns => {
    const events: Event[] = []
    for (const [index, costs] of turns.entries()) {
      const turnId = `turn-${index}`
      events.push({ type: "TurnRequested", turnId, text: "Price this run" })
      for (const [call, usd] of costs.entries()) {
        const callId = `${turnId}/${call}`
        events.push({ type: "ModelCalled", purpose: "inference", turnId, callId, model: { provider: "test", model_id: "test" }, contextWindowTokens: 4096 })
        events.push({ type: "ModelReturned", purpose: "inference", callId, text: "Done", toolCalls: [], usage: { input: 1, output: 1, usd } })
      }
      events.push({ type: "TurnSettled", turnId, outcome: "completed", callId: `${turnId}/${costs.length - 1}` })
    }
    const projection = createStore(Context.make(EventLog, { events: atom(events) }))
    try {
      expect(projection.get(usdSpend)).toEqual(turns.map((costs, index) => ({ turnId: `turn-${index}`, usd: costs.includes(null) ? null : costs.reduce<number>((sum, cost) => sum + cost!, 0) })))
    } finally { projection.dispose() }
  }), { numRuns: 30, includeErrorInReport: true })
})

for (const coldMinBytes of [0, Number.MAX_SAFE_INTEGER]) test(`actor result policy is independent of input digesting (${coldMinBytes})`, async () => {
  const db = new Database(":memory:")
  const journal = synchronousJournal<{ type: "Tick" }>({ actor: "policy", cacheBytes: 0, driver: { identity: db, execute: (sql, parameters) => db.query<Record<string, unknown>, (typeof parameters)[number][]>(sql).all(...parameters), transaction: work => db.transaction(work)() } })
  const Job = act({ name: "policy.result", input: Schema.Null, success: Schema.String, failure: Schema.String })
  const actor = defineActor("policy", Effect.sync(() => {
    const request = Job.request({ input: null })
    return { schema: Schema.Struct({ type: Schema.Literal("Tick") }), atom: effectAtom(get => ({ view: get(request.result), events: {}, acts: { job: request } })) }
  }))
  let tick: Effect.Effect<unknown, Error> = Effect.void
  const store = await Effect.runPromise(createActorStore({ actor, journal, actorContext: Context.pick(), effectInput: { digestMinBytes: 0 }, effectResult: { coldMinBytes }, checkpoint: { mode: "manual", options: { maxBytes: 1024 } }, services: runtime => { tick = runtime.send([{ type: "Tick" }]); return Job.layer(() => Effect.succeed("x".repeat(4096))) } }))
  try {
    await Effect.runPromise(store.wait)
    await Effect.runPromise(tick)
    const result = store.getState().view
    expect(result.status).toBe("fulfilled")
    if (result.status !== "fulfilled") throw new Error("Result did not settle")
    expect(Boolean(Object.getOwnPropertyDescriptor(result, "value")?.get)).toBe(coldMinBytes === 0)
    expect(result.value).toBe("x".repeat(4096))
    await expect(Effect.runPromise(store.checkpoint)).rejects.toThrow("Checkpoint exceeds maxBytes 1024")
  } finally { await Effect.runPromise(store.close); await Effect.runPromise(journal.close); db.close() }
})

test("actor results use the journal session across checkpoint and reopen", async () => {
  const db = new Database(":memory:")
  const driver = { identity: db, execute: (sql: string, parameters: readonly (string | number | null | Uint8Array)[]) => db.query<Record<string, unknown>, (typeof parameters)[number][]>(sql).all(...parameters), transaction: <Value>(work: () => Value) => db.transaction(work)() }
  const openJournal = () => synchronousJournal<{ type: "Tick" }>({ actor: "required-session", driver, cacheBytes: 0 })
  let journal = openJournal(), calls = 0
  const value = "x".repeat(4096)
  const Job = act({ name: "required.result", input: Schema.Null, success: Schema.String, failure: Schema.String })
  const actor = defineActor("required-session", Effect.sync(() => {
    const request = Job.request({ input: null })
    return { schema: Schema.Struct({ type: Schema.Literal("Tick") }), atom: effectAtom(get => ({ view: get(request.result), events: {}, acts: { job: request } })) }
  }))
  let tick: Effect.Effect<unknown, Error> = Effect.void
  const open = () => Effect.runPromise(createActorStore({ actor, journal, actorContext: Context.pick(), checkpoint: { mode: "manual" }, services: runtime => {
    tick = runtime.send([{ type: "Tick" }])
    return Job.layer(() => Effect.sync(() => { calls++; return value }))
  } }))
  let store = await open()
  const verify = () => {
    const result = store.getState().view
    expect(result.status).toBe("fulfilled")
    if (result.status !== "fulfilled") throw new Error("Result did not settle")
    expect(result.value).toBe(value)
    expect(typeof Object.getOwnPropertyDescriptor(result, "value")?.get).toBe("function")
  }
  try {
    await Effect.runPromise(store.wait)
    await Effect.runPromise(tick)
    verify()
    await Effect.runPromise(store.checkpoint)
    await Effect.runPromise(store.close)
    await Effect.runPromise(journal.close)
    journal = openJournal()
    await Effect.runPromise(journal.collect)
    store = await open()
    verify()
    expect(calls).toBe(1)
  } finally { await Effect.runPromise(store.close); await Effect.runPromise(journal.close); db.close() }
})

for (const property of actorProperties) test(property.name, () => property.run(withSqlite, property.bunRuns), 30_000)
