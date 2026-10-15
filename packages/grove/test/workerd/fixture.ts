import { DurableObject } from "cloudflare:workers"
import { Effect, Layer, ManagedRuntime } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { JsonTree, type Path } from "@tardie/grove"
import { GroveError } from "@tardie/grove/effect"
import * as Grove from "@tardie/grove"
import { Grove as GroveStorage, layer, nativeLoader } from "@tardie/grove/sqlite"

const outcome = <A, E, R>(work: Effect.Effect<A, E, R>) => work.pipe(Effect.match({ onSuccess: success => ({ _tag: "Success" as const, success }), onFailure: failure => ({ _tag: "Failure" as const, failure: { message: GroveError.from(failure).message } }) }))

export class GroveDO extends DurableObject {
  private readonly runtime = ManagedRuntime.make(layer({ chunkBytes: 4096, cacheBytes: 8192 }).pipe(Layer.provideMerge(SqliteClient.layer({ storage: this.ctx.storage }))))
  seed(size: number) { return this.runtime.runPromise(Effect.gen(function* () {
    const grove = yield* GroveStorage
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE IF NOT EXISTS events (name TEXT PRIMARY KEY)`
    const value = { history: Array.from({ length: size }, (_, n) => ({ n, text: `message ${n}` })), archive: "x".repeat(150000) }
    const original = yield* grove.publish("checkpoint", JsonTree.make().from(value), null)
    yield* grove.replaceOwners("pending", [{ name: "", root: original.root }])
    return original
  })) }
  append(expected: string, fail = false) { return this.runtime.runPromise(Effect.gen(function* () {
    const grove = yield* GroveStorage
    const sql = yield* SqlClient.SqlClient
    return yield* grove.transaction(Effect.gen(function* () {
      const result = yield* grove.append("checkpoint", expected, ["history"], [{ n: 100000, text: "next" }])
      yield* sql`INSERT INTO events (name) VALUES ('appended')`
      if (fail) return yield* new GroveError({ message: "Injected rollback" })
      return result
    }))
  }).pipe(outcome)) }
  set(expected: string) { return this.runtime.runPromise(GroveStorage.use(grove => grove.set("checkpoint", expected, ["history", 0, "text"], "edited")).pipe(outcome)) }
  read(owner: string, path: Path): Promise<unknown> { return this.runtime.runPromise(GroveStorage.use(grove => grove.read(owner, path)).pipe(outcome)) }
  readNative(owner: string, path: Path): Promise<unknown> { return this.runtime.runPromise(Effect.gen(function* () {
    const grove = yield* GroveStorage
    const root = yield* grove.root(owner)
    if (!root) return yield* new GroveError({ message: "Missing owner" })
    const load = yield* nativeLoader
    return Grove.make({ load, options: { cacheBytes: 0 } }).read(root, path)
  })) }
  slice(owner: string, start: number, end: number): Promise<unknown> { return this.runtime.runPromise(GroveStorage.use(grove => grove.slice(owner, ["history"], start, end))) }
  release(owner: string, expected: string) { return this.runtime.runPromise(GroveStorage.use(grove => grove.release(owner, expected))) }
  collect() { return this.runtime.runPromise(GroveStorage.use(grove => grove.collect)) }
  inspect() { return this.runtime.runPromise(Effect.gen(function* () {
    const grove = yield* GroveStorage
    const sql = yield* SqlClient.SqlClient
    return { cache: grove.stats(), root: yield* grove.root("checkpoint"), nodes: (yield* sql<{ n: number }>`SELECT COUNT(*) n FROM grove_nodes`)[0]!.n, events: (yield* sql<{ n: number }>`SELECT COUNT(*) n FROM events`)[0]!.n }
  })) }
  corrupt() { return this.runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE grove_nodes SET payload = NULL WHERE hash = (SELECT root FROM grove_owners WHERE name = 'checkpoint')`
    yield* sql`DELETE FROM grove_chunks WHERE hash = (SELECT root FROM grove_owners WHERE name = 'checkpoint')`
  })) }
}

export default { fetch: () => new Response("Grove fixture") }
