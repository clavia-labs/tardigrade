import { expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { JsonTree } from "@tardie/grove"
import { GroveError } from "@tardie/grove/effect"
import { Grove, layer, make } from "@tardie/grove/sqlite"

test("SQLite owners preserve old roots, reject stale edits, roll back and collect", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  for (const maxParameters of [3, 4]) {
    expect((yield* make({ maxParameters }).pipe(Effect.flip)).message).toContain("maxParameters")
  }
  const store = yield* make({ maxParameters: 5, chunkBytes: 127, cacheBytes: 512, pageItems: 3, fanout: 3, leafBytes: 64 })
  const tree = JsonTree.make({ pageItems: 3, fanout: 3, leafBytes: 64 })
  const value = { history: Array.from({ length: 50 }, (_, n) => ({ n, text: `message ${n}` })) }
  const original = yield* store.publish("checkpoint", tree.from(value), null)
  yield* store.retain("pending", original.root, null)
  yield* store.replaceOwners("views/", [{ name: "active", root: original.root }])
  yield* store.replaceOwners("view/", [{ name: "other", root: original.root }])
  const badOwners = yield* store.replaceOwners("views/", [{ name: "missing", root: "missing" }]).pipe(Effect.exit)
  expect(Exit.isFailure(badOwners)).toBe(true)
  expect(yield* store.root("views/active")).toBe(original.root)
  yield* store.replaceOwners("views/", [])
  expect(yield* store.root("views/active")).toBeUndefined()
  expect(yield* store.root("view/other")).toBe(original.root)
  yield* store.replaceOwners("view/", [])
  const before = yield* store.root("checkpoint")
  const rolledBack = yield* store.transaction(Effect.gen(function* () {
    yield* store.append("checkpoint", original.root, ["history"], [{ n: 50, text: "rollback" }])
    return yield* new GroveError({ message: "Injected rollback" })
  })).pipe(Effect.exit)
  expect(Exit.isFailure(rolledBack)).toBe(true)
  expect(yield* store.root("checkpoint")).toBe(before)
  const next = yield* store.append("checkpoint", original.root, ["history"], [{ n: 50, text: "next" }])
  expect(yield* store.read("pending")).toEqual(value)
  const restored = yield* store.tree("pending")
  expect(restored.root).toBe(original.root)
  expect(tree.materialize(restored)).toEqual(value)
  expect(yield* store.slice("checkpoint", ["history"], 50, 51)).toEqual([{ n: 50, text: "next" }])
  expect(Exit.isFailure(yield* store.set("checkpoint", original.root, ["history", 0], null).pipe(Effect.exit))).toBe(true)
  expect(Exit.isFailure(yield* store.release("checkpoint", original.root).pipe(Effect.exit))).toBe(true)
  const reopened = yield* make({ chunkBytes: 127, cacheBytes: 512, pageItems: 3, fanout: 3, leafBytes: 64 })
  expect(reopened.stats().loadedNodes).toBe(0)
  const edited = yield* reopened.set("checkpoint", next.root, ["history", 0, "text"], "edited")
  yield* reopened.collect
  expect(yield* reopened.read("pending", ["history", 0, "text"])).toBe("message 0")
  expect(yield* reopened.read("checkpoint", ["history", 0, "text"])).toBe("edited")
  expect(reopened.stats().cachedBytes).toBeLessThanOrEqual(512)
  yield* reopened.release("checkpoint", edited.root)
  yield* reopened.release("pending", original.root)
  yield* reopened.release("pending", original.root)
  expect((yield* reopened.collect).nodes).toBeGreaterThan(0)
  const sql = yield* SqlClient.SqlClient
  expect((yield* sql<{ n: number }>`SELECT COUNT(*) n FROM grove_nodes`)[0]!.n).toBe(0)
  expect((yield* sql<{ n: number }>`SELECT COUNT(*) n FROM grove_chunks`)[0]!.n).toBe(0)
  expect(Exit.isFailure(yield* reopened.retain("missing", original.root, null).pipe(Effect.exit))).toBe(true)
}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))))))

test("Grove layer supplies a typed storage dependency", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const grove = yield* Grove
  const original = JsonTree.make({ leafBytes: 2 }).from({ value: null, repeated: null })
  yield* grove.publish("state", original, null)
  expect(yield* grove.read("state", ["value"])).toBeNull()
  const decoded = yield* grove.tree("state")
  yield* Effect.gen(function* () {
    const destination = yield* make()
    yield* destination.publish("copied", decoded, null)
    expect(yield* destination.read("copied")).toEqual({ value: null, repeated: null })
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })))
}).pipe(Effect.provide(layer().pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" }))))))))
