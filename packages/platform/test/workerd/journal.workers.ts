import { env } from "cloudflare:workers"
import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { expect, test } from "vitest"
import { Effect, Schema } from "effect"
import { decodeReference, encodeReference } from "@tardie/grove"
import { prepareDocumentInput } from "@clavia/tardigrade-core/services/tree-state"
import { checkpointDigest, encodeCheckpoint, watchdogKey } from "@clavia/tardigrade-core"
import { synchronousJournal } from "../../src/shared/synchronous-journal"
import { CLOUDFLARE_SQL_LIMITS } from "../../src/cloudflare/limits"
import type { TestPromiseResolver } from "../fixtures/workerd/fixture.worker"
import type { SyncSqlite } from "@tardie/grove/sqlite"
import { journalProperties } from "../properties/integration"
import { withSqlite } from "../fixtures/workerd/sqlite"

const State = Schema.Struct({ messages: Schema.Array(Schema.Struct({ text: Schema.String })) })
const driverFor = (storage: DurableObjectStorage): SyncSqlite => ({ identity: storage.sql, execute: (sql, parameters) => storage.sql.exec(sql, ...parameters).toArray(), transaction: work => storage.transactionSync(work) })

test("native stored inputs publish atomically and reopen the old version after eviction", async () => {
  const namespace = (env as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
  const stub = namespace.getByName("stored-journal-input")
  const refs = await runInDurableObject(stub, async (_instance, state) => {
    const native = driverFor(state.storage)
    let fail = true
    const driver: SyncSqlite = { ...native, execute: (sql, parameters) => {
      if (fail && sql.startsWith("INSERT INTO experimental_events")) throw new Error("Injected native acceptance failure")
      return native.execute(sql, parameters)
    } }
    const journal = synchronousJournal<{ type: string }>({ actor: "native", driver, cacheBytes: 0, chunkBytes: 64 })
    const a = journal.storedValues!.bind(State).initial({ messages: [{ text: "A".repeat(2048) }] })
    const ref = { atom: "job", act: "job", seq: 1 }
    const request = { act: "job", ...prepareDocumentInput({ context: a.selectEach(["messages"], ["text"], { start: 0, end: 1 }) }) }
    const changes = { documents: { references: [{ name: "history", reference: encodeReference(a.reference!) }] }, put: [{ ref, request }] }
    await expect(Effect.runPromise(journal.append(0, [{ event: { type: "Accepted" } }], changes))).rejects.toThrow("Injected")
    expect(await Effect.runPromise(journal.read)).toEqual([])
    expect(journal.grove.owners("")).toEqual([])
    fail = false
    await Effect.runPromise(journal.append(0, [{ event: { type: "Accepted" } }], changes))
    const b = a.set(["messages", 0, "text"], "B")
    await Effect.runPromise(journal.append(1, [{ event: { type: "Advanced" } }], { documents: { references: [{ name: "history", reference: encodeReference(b.reference!) }] } }))
    await Effect.runPromise(journal.collect)
    await Effect.runPromise(journal.close)
    return { a: encodeReference(a.reference!), b: encodeReference(b.reference!) }
  })
  await evictDurableObject(stub)
  await runInDurableObject(stub, async (_instance, state) => {
    const journal = synchronousJournal<{ type: string }>({ actor: "native", driver: driverFor(state.storage), cacheBytes: 0, chunkBytes: 64 })
    const input = (await Effect.runPromise(journal.readInputs))[0]!
    expect(journal.storedValues!.resolve(input.request)).toEqual({ context: ["A".repeat(2048)] })
    expect(journal.storedValues!.bind(State).open(refs.b).read(["messages", 0, "text"])).toBe("B")
    await Effect.runPromise(journal.append(2, [{ event: { type: "Completed" } }], { remove: [input.ref] }))
    await Effect.runPromise(journal.collect)
    expect(await Effect.runPromise(journal.readInputs)).toEqual([])
    expect(() => journal.grove.view(decodeReference(refs.a), State).materialize()).toThrow()
    expect(journal.grove.stats()).toMatchObject({ stagedNodes: 0, activeLeases: 0 })
    await Effect.runPromise(journal.close)
  })
})

test("native chunked message receipts commit atomically and reopen after eviction", async () => {
  const namespace = (env as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
  const stub = namespace.getByName("stored-journal-delivery")
  const text = "x".repeat(3 * 1024 * 1024)
  const message = { id: "native-message", from: { kind: "external" as const, id: "sender" } }
  const record = { message, event: { type: "MessageReceived" as const, body: { text } } }
  await runInDurableObject(stub, async (_instance, state) => {
    const native = driverFor(state.storage)
    let fail = true
    const driver: SyncSqlite = { ...native, execute: (sql, parameters) => {
      if (fail && sql.startsWith("INSERT INTO experimental_messages")) throw new Error("Injected native receipt failure")
      return native.execute(sql, parameters)
    } }
    const journal = synchronousJournal({ actor: "delivery", driver, limits: CLOUDFLARE_SQL_LIMITS, eventInlineBytes: 1024, flush: Effect.tryPromise(() => state.storage.sync()) })
    const document = journal.storedValues.bind(State).initial({ messages: [{ text: "accepted" }] })
    const changes = { documents: { references: [{ name: "history", reference: encodeReference(document.reference!) }] } }
    await expect(Effect.runPromise(journal.append(0, [record], changes))).rejects.toThrow("native receipt")
    expect(await Effect.runPromise(journal.readMessage(message.id))).toBeUndefined()
    expect(journal.grove.owners("")).toEqual([])
    expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM experimental_event_chunks").one().n).toBe(0)
    fail = false
    await Effect.runPromise(journal.append(0, [record], changes))
    expect((await Effect.runPromise(journal.readMessage(message.id)))!.position).toBe(1)
    await Effect.runPromise(journal.close)
  })
  await evictDurableObject(stub)
  await runInDurableObject(stub, async (_instance, state) => {
    const journal = synchronousJournal({ actor: "delivery", driver: driverFor(state.storage), limits: CLOUDFLARE_SQL_LIMITS, flush: Effect.tryPromise(() => state.storage.sync()) })
    expect(await Effect.runPromise(journal.readMessage(message.id))).toEqual({ position: 1, record })
    expect(await Effect.runPromise(journal.readFirst)).toEqual(record)
    await Effect.runPromise(journal.acknowledge)
    await expect(Effect.runPromise(journal.append(1, [record]))).rejects.toThrow()
    expect(await Effect.runPromise(journal.readVersion)).toEqual({ position: 1, pendingEffects: 0 })
    await Effect.runPromise(journal.close)
  })
})

test("native recovery admission rolls back with publication and restores alarms after eviction", async () => {
  const namespace = (env as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
  const stub = namespace.getByName("stored-journal-recovery")
  const target = { actor: "chat", instance: "native", thread: "main" }
  await runInDurableObject(stub, async (_instance, state) => {
    const native = driverFor(state.storage)
    let fail = true
    const driver: SyncSqlite = { ...native, execute: (sql, parameters) => {
      if (fail && sql.startsWith("INSERT INTO watchdogs")) throw new Error("Injected native watchdog failure")
      return native.execute(sql, parameters)
    } }
    const journal = synchronousJournal({ actor: "recovery", driver,
      scheduler: { alarm: { set: at => Effect.tryPromise(() => state.storage.setAlarm(at)), clear: Effect.tryPromise(() => state.storage.deleteAlarm()) }, deliver: () => Effect.void },
      watchdog: { target, recover: () => Effect.succeed({ status: "settled", progressCursor: 1 }), invalidate: () => Effect.void },
      flush: Effect.tryPromise(() => state.storage.sync()),
    })
    const document = journal.storedValues.bind(State).initial({ messages: [{ text: "recover" }] })
    const changes = { documents: { references: [{ name: "history", reference: encodeReference(document.reference!) }] } }
    await expect(Effect.runPromise(journal.append(0, [{ event: { type: "MessageReceived" } }], changes))).rejects.toThrow("native watchdog")
    expect(journal.grove.owners("")).toEqual([])
    expect(await Effect.runPromise(journal.readCheckpoint)).toBeUndefined()
    expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM experimental_events").one().n).toBe(0)
    expect(await state.storage.getAlarm()).toBeNull()
    fail = false
    await Effect.runPromise(journal.append(0, [{ event: { type: "MessageReceived" } }], changes))
    expect(await state.storage.getAlarm()).not.toBeNull()
    await Effect.runPromise(journal.close)
    await state.storage.deleteAlarm()
  })
  await evictDurableObject(stub)
  await runInDurableObject(stub, async (_instance, state) => {
    let recovered = 0
    const journal: ReturnType<typeof synchronousJournal> = synchronousJournal({ actor: "recovery", driver: driverFor(state.storage),
      scheduler: { alarm: { set: at => Effect.tryPromise(() => state.storage.setAlarm(at)), clear: Effect.tryPromise(() => state.storage.deleteAlarm()) }, deliver: () => Effect.suspend(() => journal.watchdog!.alarm) },
      watchdog: { target, recover: () => Effect.gen(function* () {
        expect((yield* journal.watchdog!.status).get(watchdogKey(target))!.attempts).toBe(1)
        recovered++
        return { status: "settled" as const, progressCursor: 1 }
      }), invalidate: () => Effect.void }, flush: Effect.tryPromise(() => state.storage.sync()),
    })
    expect((await Effect.runPromise(journal.read)).length).toBe(1)
    expect(await state.storage.getAlarm()).not.toBeNull()
    await Effect.runPromise(journal.scheduler!.alarm)
    expect(recovered).toBe(1)
    expect((await Effect.runPromise(journal.watchdog!.status)).size).toBe(0)
    expect(await state.storage.getAlarm()).toBeNull()
    await Effect.runPromise(journal.close)
  })
})

test("native oversized journal envelopes roll back partial chunks and reopen after eviction", async () => {
  const namespace = (env as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
  const stub = namespace.getByName("stored-journal-chunks")
  const text = "x".repeat(3 * 1024 * 1024)
  const ref = { atom: "job", act: "job", seq: 1 }
  await runInDurableObject(stub, async (_instance, state) => {
    const native = driverFor(state.storage)
    let fail = true
    const driver: SyncSqlite = { ...native, execute: (sql, parameters) => {
      if (fail && sql.startsWith("INSERT INTO experimental_event_chunks") && parameters[2] === 1) throw new Error("Injected partial chunk failure")
      return native.execute(sql, parameters)
    } }
    const journal = synchronousJournal<{ type: string; text?: string }>({ actor: "chunks", driver, limits: CLOUDFLARE_SQL_LIMITS, eventInlineBytes: 1024 })
    const a = journal.storedValues!.bind(State).initial({ messages: [{ text: "retained" }] })
    const request = { act: "job", ...prepareDocumentInput({ context: a.selectEach(["messages"], ["text"], { start: 0, end: 1 }), text }) }
    const payload = encodeCheckpoint({ position: 1, durable: [{ name: "inline", position: 1, state: { text } }], operations: [] })
    const saved = { position: 1, payload, digest: await Effect.runPromise(checkpointDigest(payload)) }
    const changes = { documents: { references: [{ name: "history", reference: encodeReference(a.reference!) }] }, put: [{ ref, request }] }
    await expect(Effect.runPromise(journal.appendWithCheckpoint(0, [{ event: { type: "Large", text } }], saved, changes))).rejects.toThrow("partial chunk")
    expect(await Effect.runPromise(journal.read)).toEqual([])
    expect(await Effect.runPromise(journal.readInputs)).toEqual([])
    expect(journal.grove.owners("")).toEqual([])
    for (const table of ["experimental_event_chunks", "journal_accepted_input_chunks", "journal_checkpoint_chunks"]) expect(state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`).one().n).toBe(0)
    fail = false
    await Effect.runPromise(journal.appendWithCheckpoint(0, [{ event: { type: "Large", text } }], saved, changes))
    for (const table of ["experimental_event_chunks", "journal_accepted_input_chunks", "journal_checkpoint_chunks"]) expect(state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`).one().n).toBeGreaterThan(1)
    await Effect.runPromise(journal.close)
  })
  await evictDurableObject(stub)
  await runInDurableObject(stub, async (_instance, state) => {
    const journal = synchronousJournal<{ type: string; text?: string }>({ actor: "chunks", driver: driverFor(state.storage), limits: CLOUDFLARE_SQL_LIMITS })
    expect((await Effect.runPromise(journal.read))[0]!.event).toEqual({ type: "Large", text })
    const input = (await Effect.runPromise(journal.readInputs))[0]!
    expect(input.request.input).toMatchObject({ text })
    expect(journal.storedValues!.resolve(input.request)).toEqual({ context: ["retained"], text })
    const old = (await Effect.runPromise(journal.readCheckpoint))!
    expect(JSON.parse(new TextDecoder().decode(old.payload)).durable[0].state).toEqual({ text })
    const payload = encodeCheckpoint({ position: 2, durable: [], operations: [] })
    await Effect.runPromise(journal.appendWithCheckpoint(1, [{ event: { type: "Done" } }], { position: 2, payload, digest: await Effect.runPromise(checkpointDigest(payload)) }, { remove: [ref] }))
    expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM journal_accepted_input_chunks").one().n).toBe(0)
    expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM journal_checkpoint_chunks").one().n).toBe(1)
    expect((await Effect.runPromise(journal.readCheckpoint))!.payload).toEqual(payload)
    await Effect.runPromise(journal.close)
  })
})

for (const property of journalProperties) test(property.name, () => property.run(withSqlite, property.workerRuns), 30_000)
