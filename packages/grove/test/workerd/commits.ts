import { Schema } from "effect"
import { decodeReference, encodeReference } from "@tardie/grove"
import { makeSync, type SyncStore } from "@tardie/grove/sqlite"

const Message = Schema.Struct({ text: Schema.String })
const State = Schema.Struct({ messages: Schema.Array(Message), archive: Schema.String, jobs: Schema.Record(Schema.String, Schema.Struct({ status: Schema.String })), audit: Schema.Array(Schema.String), note: Schema.optionalKey(Schema.String) })
export type CommitAction = "seed" | "rollback" | "edit" | "read" | "lease" | "release" | "structure" | "structure-rollback" | "seed-large" | "seed-keyed"
export interface CommitProbe {
  readonly failure: string | null
  readonly current: string | null
  readonly messages: readonly string[] | null
  readonly jobKeys: readonly string[]
  readonly audit: readonly string[]
  readonly notePresent: boolean
  readonly input: readonly string[] | null
  readonly journalRows: number
  readonly nodes: number
  readonly activeLeases: number
  readonly leaseValue: string | null
  readonly missingAfterLease: boolean
}
export const commitStore = (ctx: DurableObjectState) => makeSync({
  identity: ctx.storage.sql,
  execute: (statement, parameters) => ctx.storage.sql.exec(statement, ...parameters).toArray(),
  transaction: work => ctx.storage.transactionSync(work),
}, { scope: ctx.id.toString(), chunkBytes: 4096, cacheBytes: 0 })

export function commitProbe(ctx: DurableObjectState, store: SyncStore, action: CommitAction): CommitProbe {
  const sql = ctx.storage.sql
  sql.exec("CREATE TABLE IF NOT EXISTS value_journal(id TEXT PRIMARY KEY,input TEXT)")
  let failure: string | null = null, leaseValue: string | null = null, missingAfterLease = false
  try {
    if (action === "seed" || action === "seed-large" || action === "seed-keyed") {
      const document = store.bind(State).initial({ messages: [{ text: "before" }, { text: "second" }, ...(action === "seed-large" ? Array.from({ length: 998 }, (_, index) => ({ text: `message ${index + 2}` })) : [])], archive: "x".repeat(20000), jobs: { first: { status: "pending" }, ...Object.fromEntries(action === "seed-keyed" ? Array.from({ length: 1024 }, (_, index) => [`job-${index}`, { status: "pending" }]) : []) }, audit: [], note: "present" })
      const input = document.selectEach(["messages"], ["text"], { start: 0, end: 2 })
      store.transaction(tx => {
        store.commit(tx, { publish: [{ owner: "document", expected: null, document }], retain: [{ owner: "input", selection: input }] })
        tx.execute("INSERT INTO value_journal VALUES(?,?)", ["seed", encodeReference(store.reference(input))])
      })
    }
    if (action === "edit" || action === "rollback") {
      const head = store.owner("document")!
      const document = store.bind(State).open(head).set(["messages", 0, "text"], "corrected")
      store.transaction(tx => {
        store.commit(tx, { publish: [{ owner: "document", expected: head, document }] })
        tx.execute("INSERT INTO value_journal VALUES(?,NULL)", [action])
        if (action === "rollback") throw new Error("Injected commit rollback")
      })
      store.discard()
      store.collect()
    }
    if (action === "structure" || action === "structure-rollback") {
      const head = store.owner("document")!
      const document = store.bind(State).open(head).batch(edit => {
        edit.splice(["messages"], 0, 1)
        edit.append(["messages"], [{ text: "appended" }])
        edit.set(["messages", 0, "text"], "corrected-second")
        edit.remove(["jobs", "first"])
        edit.set(["jobs", "next"], { status: "ready" })
        edit.append(["audit"], ["structured"])
        edit.remove(["note"])
      })
      store.transaction(tx => {
        store.commit(tx, { publish: [{ owner: "document", expected: head, document }] })
        tx.execute("INSERT INTO value_journal VALUES(?,NULL)", [action])
        if (action === "structure-rollback") throw new Error("Injected structural rollback")
      })
      store.discard()
      store.collect()
    }
    if (action === "lease") {
      const input = store.owner("input")!
      const view = store.view(input, Schema.Array(Schema.String))
      const iterator = view.scan([])
      iterator.next()
      store.transaction(tx => store.commit(tx, { release: [{ owner: "input", expected: input }] }))
      const other = commitStore(ctx)
      other.collect()
      leaseValue = view.read([0])
      iterator.return?.()
      other.collect()
      try { view.read([0]) } catch { missingAfterLease = true }
    }
    if (action === "release") {
      const head = store.owner("document")!
      store.transaction(tx => store.commit(tx, { release: [{ owner: "document", expected: head }] }))
      store.collect()
    }
  } catch (cause) { failure = cause instanceof Error ? cause.message : String(cause) }
  const head = store.owner("document")
  const input = store.owner("input")
  const current = head ? store.view(head, State).materialize() : null
  return {
    failure,
    current: current?.messages[0]?.text ?? null,
    messages: current ? current.messages.map(message => message.text) : null,
    jobKeys: current ? Object.keys(current.jobs).sort() : [],
    audit: current?.audit ?? [],
    notePresent: current ? Object.hasOwn(current, "note") : false,
    input: input ? store.view(decodeReference(encodeReference(input)), Schema.Array(Schema.String)).materialize() : null,
    journalRows: sql.exec<{ n: number }>("SELECT COUNT(*) n FROM value_journal").one().n,
    nodes: sql.exec<{ n: number }>("SELECT COUNT(*) n FROM grove_value_nodes").one().n,
    activeLeases: store.stats().activeLeases,
    leaseValue, missingAfterLease,
  }
}
