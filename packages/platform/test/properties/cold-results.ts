import { Effect, Schema } from "effect"
import { act, createEventLog, effectAtom, encodeCheckpoint, decodeCheckpoint, checkpointDigest, type EffectCheckpoint, type JournalEvent } from "@clavia/tardigrade-core"
import { storeRequest } from "@clavia/tardigrade-core/runtime/input-digest"
import type { SyncSqlite } from "@tardie/grove/sqlite"
import { synchronousJournal } from "../../src/shared/synchronous-journal"

const Tick = Schema.Struct({ type: Schema.Literal("Tick") })
const Job = act({ name: "test.cold-result", input: Schema.Null, success: Schema.String, failure: Schema.String })

// coldResultScenario checks lazy reads, rollback, duplicate delivery and checkpoint ownership for direct and promised results.
export async function coldResultScenario(driver: SyncSqlite, payload: string, promised: boolean, failCommit: boolean, inlineCheckpoint = false) {
  let fail = false
  const checked: SyncSqlite = { ...driver, execute: (sql, parameters) => {
    if (fail && sql.startsWith("INSERT INTO experimental_events")) throw new Error("Injected cold result failure")
    return driver.execute(sql, parameters)
  } }
  let journal = synchronousJournal<typeof Tick.Type>({ actor: "cold-result", driver: checked, cacheBytes: 0 })
  let reads = 0
  const open = (checkpoint?: EffectCheckpoint) => {
    const request = Job.request({ input: null })
    const documents = { ...journal.storedValues, read: (encoded: string) => { reads++; return journal.storedValues.read(encoded) } }
    return createEventLog({ schema: Tick, documents, digestMinBytes: 0, resultMinBytes: 2048, ...(checkpoint ? { checkpoint } : {}), atoms: {
      root: effectAtom(get => ({ view: get(request.result), events: {}, acts: { job: request } })),
    } })
  }
  let log = open()
  try {
    let snapshot = log.initial
    const append = async (event: JournalEvent<typeof Tick.Type>, inject = false) => {
      const position = snapshot.position
      snapshot = log.append(snapshot, event)
      if (inject) {
        fail = true
        let rejected = false
        try { await Effect.runPromise(journal.append(position, [{ event }])) } catch { rejected = true }
        finally { fail = false }
        if (!rejected) throw new Error("Cold result transaction did not fail")
      }
      await Effect.runPromise(journal.append(position, [{ event }]))
    }
    const ref = { atom: "root", act: Job.name, seq: 0 }
    await append({ type: "EffectRequested", ref, request: storeRequest(snapshot.effects()[0]!.request) })
    await append({ type: "EffectSettled", ref, outcome: { status: "fulfilled", value: promised ? { type: "promise", handle: { executor: "test", id: "job" } } : { type: "value", value: payload } } })
    if (promised) await append({ type: "PromiseSettled", ref, result: { status: "fulfilled", value: payload } })
    const settledSnapshot = snapshot
    await append({ type: "Tick" }, failCommit)
    if (snapshot.view().root.view.status !== "fulfilled" || reads) throw new Error("Reading status loaded a cold result")
    const cold = snapshot.effect(ref)?.execution.results
    if (!(promised ? cold?.promise : cold?.value)) throw new Error("Large result was not stored cold")
    const result = snapshot.view().root.view
    if (result.status !== "fulfilled" || result.value !== payload || reads !== 1) throw new Error("Cold result changed its value")
    const historical = settledSnapshot.effect(ref)
    const historicalValue = promised ? historical?.execution.promise?.result : historical?.execution.outcome?.type === "EffectSettled" ? historical.execution.outcome.outcome : undefined
    if (historicalValue?.status !== "fulfilled") throw new Error("Historical result lost its status")
    const expected = promised ? payload : { type: "value", value: payload }
    if (JSON.stringify(historicalValue.value) !== JSON.stringify(expected)) throw new Error("Historical snapshot lost its result")
    const checkpoint = snapshot.checkpoint()!
    const saved = inlineCheckpoint ? { ...checkpoint, operations: checkpoint.operations.map(operation => {
      const execution = { ...operation.execution }
      delete execution.results; delete execution.retired
      if (promised && execution.promise) execution.promise = { ...execution.promise, result: { status: "fulfilled" as const, value: payload } }
      else if (execution.outcome?.type === "EffectSettled") execution.outcome = { ...execution.outcome, outcome: { status: "fulfilled" as const, value: { type: "value", value: payload } } }
      return { ...operation, execution }
    }) } : checkpoint
    const bytes = encodeCheckpoint(saved)
    if (!inlineCheckpoint && bytes.length > 4096) throw new Error("Checkpoint materialized a cold result")
    await Effect.runPromise(journal.appendWithCheckpoint(snapshot.position, [], { position: snapshot.position, payload: bytes, digest: await Effect.runPromise(checkpointDigest(bytes)) }))
    log.dispose()
    await Effect.runPromise(journal.close)
    journal = synchronousJournal({ actor: "cold-result", driver: checked, cacheBytes: 0 })
    await Effect.runPromise(journal.collect)
    reads = 0
    log = open(decodeCheckpoint((await Effect.runPromise(journal.readCheckpoint))!.payload))
    snapshot = log.initial
    if (snapshot.view().root.view.status !== "fulfilled" || reads) throw new Error("Restart status loaded a result")
    const restored = snapshot.view().root.view
    if (restored.status !== "fulfilled" || restored.value !== payload || reads !== 1) throw new Error("Restart lost a cold result")
    const duplicate = promised
      ? { type: "PromiseSettled" as const, ref, result: { status: "fulfilled" as const, value: payload } }
      : { type: "EffectSettled" as const, ref, outcome: { status: "fulfilled" as const, value: { type: "value" as const, value: payload } } }
    snapshot = log.append(snapshot, duplicate)
    if (snapshot.view().root.view.status !== "fulfilled") throw new Error("Duplicate settlement changed status")
  } finally { log.dispose(); await Effect.runPromise(journal.close) }
}
