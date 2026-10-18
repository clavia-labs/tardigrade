import { DurableObject } from "cloudflare:workers"
import { Schema } from "effect"
import { decodeReference, encodeReference, type Path } from "@tardie/grove"
import { makeSync } from "@tardie/grove/sqlite"

const State = Schema.Struct({ history: Schema.Array(Schema.Struct({ n: Schema.Int, text: Schema.String })), archive: Schema.String })
const outcome = <Value>(work: () => Value) => {
  try { return { _tag: "Success" as const, success: work() } }
  catch (cause) { return { _tag: "Failure" as const, failure: { message: cause instanceof Error ? cause.message : String(cause) } } }
}

export class GroveDO extends DurableObject {
  private open(cacheBytes = 8192) {
    return makeSync({
      identity: this.ctx.storage.sql,
      execute: (statement, parameters) => this.ctx.storage.sql.exec(statement, ...parameters).toArray(),
      transaction: work => this.ctx.storage.transactionSync(work),
    }, { scope: this.ctx.id.toString(), chunkBytes: 4096, cacheBytes })
  }
  private readonly store = this.open()
  private owner(store: typeof this.store, name: string) {
    const reference = store.owner(name)
    if (!reference) throw new Error("Missing owner")
    return reference
  }
  seed(size: number) {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS events (name TEXT PRIMARY KEY)")
    const document = this.store.bind(State).initial({ history: Array.from({ length: size }, (_, n) => ({ n, text: `message ${n}` })), archive: "x".repeat(150000) })
    const result = this.store.transaction(tx => this.store.commit(tx, {
      publish: [{ owner: "checkpoint", expected: null, document }],
      retain: [{ owner: "pending", selection: document.reference! }],
    }))
    return { ...result, root: encodeReference(document.reference!) }
  }
  private edit(expected: string, append: boolean, fail = false) {
    return outcome(() => {
      const before = this.store.stats(), previous = decodeReference(expected)
      const document = this.store.bind(State).open(previous)
      const next = append ? document.append(["history"], [{ n: 100000, text: "next" }]) : document.set(["history", 0, "text"], "edited")
      try {
        const result = this.store.transaction(tx => {
          const result = this.store.commit(tx, { publish: [{ owner: "checkpoint", expected: previous, document: next }] })
          if (append) tx.execute("INSERT INTO events (name) VALUES ('appended')", [])
          if (fail) throw new Error("Injected rollback")
          return result
        })
        const after = this.store.stats()
        return { ...result, root: encodeReference(next.reference!), loadedNodes: after.loadedNodes - before.loadedNodes, loadedBytes: after.loadedBytes - before.loadedBytes }
      } finally { this.store.discard() }
    })
  }
  append(expected: string, fail = false) { return this.edit(expected, true, fail) }
  set(expected: string) { return this.edit(expected, false) }
  read(owner: string, path: Path): unknown { return outcome(() => this.store.bind(State).open(this.owner(this.store, owner)).read(path as [])) }
  readFresh(owner: string, path: Path): unknown {
    const store = this.open(0)
    return store.bind(State).open(this.owner(store, owner)).read(path as [])
  }
  slice(owner: string, start: number, end: number) { return this.store.bind(State).open(this.owner(this.store, owner)).slice(["history"], start, end) }
  release(owner: string, expected: string) { return this.store.transaction(tx => this.store.commit(tx, { release: [{ owner, expected: decodeReference(expected) }] })) }
  collect() { return this.store.collect() }
  inspect() {
    const root = this.store.owner("checkpoint")
    return { cache: this.store.stats(), root: root && encodeReference(root), nodes: this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM grove_value_nodes").one().n, events: this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM events").one().n }
  }
  corrupt() {
    this.ctx.storage.sql.exec("DELETE FROM grove_value_chunks WHERE hash = (SELECT root FROM grove_value_owners WHERE name = 'checkpoint')")
  }
}

export default { fetch: () => new Response("Grove fixture") }
