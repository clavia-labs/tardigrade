import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { checkpointEncoder, decodeCheckpoint, RuntimeError } from "@clavia/tardigrade-core"
import { checkpointTrees } from "../../src/shared/checkpoint-trees"

test("checkpoint trees share unchanged state and join journal rollback", () => Effect.runPromise(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const trees = yield* checkpointTrees("actor", 127, { collectEvery: 1 })
  const peer = yield* checkpointTrees("peer", 127)
  const encode = checkpointEncoder()
  const history = Object.freeze(Array.from({ length: 10000 }, (_, n) => Object.freeze({ n, text: `message ${n}` })))
  const saved = (position: number) => {
    const payload = encode({ position, durable: [{ name: "history", state: history, position }], operations: [] })
    return { position, payload, digest: payload.root }
  }
  const first = saved(1)
  yield* sql.withTransaction(trees.write(first))
  yield* sql.withTransaction(peer.write(first))
  const count = (yield* sql<{ n: number }>`SELECT COUNT(*) n FROM grove_nodes`)[0]!.n
  const failed = yield* sql.withTransaction(Effect.gen(function* () {
    yield* trees.write(saved(2))
    return yield* Effect.fail(new RuntimeError("Injected rollback"))
  })).pipe(Effect.exit)
  expect(Exit.isFailure(failed)).toBe(true)
  expect((yield* trees.read)?.position).toBe(1)
  expect((yield* sql<{ n: number }>`SELECT COUNT(*) n FROM grove_nodes`)[0]!.n).toBe(count)
  yield* sql.withTransaction(trees.write(saved(2)))
  expect((yield* sql<{ n: number }>`SELECT COUNT(*) n FROM grove_nodes`)[0]!.n - count).toBeLessThan(10)
  const reopened = yield* checkpointTrees("actor", 1024)
  expect(decodeCheckpoint((yield* reopened.read)!.payload).position).toBe(2)
  yield* sql.withTransaction(reopened.clear)
  expect(yield* reopened.read).toBeUndefined()
  expect(decodeCheckpoint((yield* peer.read)!.payload).position).toBe(1)
  yield* sql.withTransaction(peer.clear)
  expect((yield* sql<{ n: number }>`SELECT COUNT(*) n FROM grove_nodes`)[0]!.n).toBe(0)
}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })))))
