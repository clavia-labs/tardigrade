import { Effect, Scheduler } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { make as makeGrove, type Options as GroveOptions } from "@tardie/grove/sqlite"
import { RuntimeError, type TreeCheckpoint } from "@clavia/tardigrade-core"

export const DEFAULT_CHECKPOINT_COLLECT_EVERY = 32
// DEFAULT_CHECKPOINT_SCHEDULER keeps journal work on microtasks because timer resumes can wait behind a Durable Object storage gate (test/workerd/thread-layout.workers.ts).
export const DEFAULT_CHECKPOINT_SCHEDULER = new Scheduler.MixedScheduler("sync")
export interface CheckpointTreeOptions extends Omit<GroveOptions, "chunkBytes" | "transaction"> {
  readonly scheduler?: Scheduler.Scheduler
  readonly collectEvery?: number
}

// checkpointTrees joins its caller's transaction for checkpoint roots and journal events (test/bun/checkpoint-trees.test.ts).
export const checkpointTrees = (actor: string, chunkBytes: number, options: CheckpointTreeOptions = {}) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const collectEvery = options.collectEvery ?? DEFAULT_CHECKPOINT_COLLECT_EVERY
  if (!Number.isSafeInteger(collectEvery) || collectEvery < 1) return yield* Effect.fail(new RuntimeError("Checkpoint collectEvery must be a positive safe integer"))
  yield* sql`CREATE TABLE IF NOT EXISTS checkpoint_trees (actor TEXT PRIMARY KEY, position INTEGER NOT NULL, commits INTEGER NOT NULL) WITHOUT ROWID`
  const grove = yield* makeGrove({ chunkBytes, ...options, transaction: work => work })
  const owner = JSON.stringify([actor, "checkpoint"])
  const stateOwners = JSON.stringify([actor, "checkpoint-state"])
  const resume = <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.provideService(work, Scheduler.Scheduler, options.scheduler ?? DEFAULT_CHECKPOINT_SCHEDULER)
  return {
    stage: (nodes: Parameters<typeof grove.stage>[0]) => resume(grove.stage(nodes)),
    retain: grove.retain,
    replaceOwners: grove.replaceOwners,
    root: grove.root,
    release: grove.release,
    read: resume(Effect.gen(function* () {
      const [row] = yield* sql<{ position: number }>`SELECT position FROM checkpoint_trees WHERE actor = ${actor}`
      if (!row) return undefined
      if (!Number.isSafeInteger(row.position) || row.position < 0) return yield* Effect.fail(new RuntimeError("Invalid journal checkpoint"))
      const payload = yield* grove.tree(owner)
      return { position: row.position, payload, digest: payload.root } satisfies TreeCheckpoint
    })),
    write: (checkpoint: TreeCheckpoint) => resume(Effect.gen(function* () {
      if (checkpoint.digest !== checkpoint.payload.root) return yield* Effect.fail(new RuntimeError("Invalid checkpoint digest"))
      yield* grove.replaceOwners(stateOwners, (checkpoint.roots ?? []).map(entry => ({ name: JSON.stringify(entry.name), root: entry.root })))
      yield* grove.publish(owner, checkpoint.payload, (yield* grove.root(owner)) ?? null)
      yield* sql`INSERT INTO checkpoint_trees (actor, position, commits) VALUES (${actor}, ${checkpoint.position}, 1) ON CONFLICT(actor) DO UPDATE SET position = excluded.position, commits = commits + 1`
      const [row] = yield* sql<{ commits: number }>`SELECT commits FROM checkpoint_trees WHERE actor = ${actor}`
      if (row!.commits % collectEvery === 0) yield* grove.collect
    })),
    clear: Effect.gen(function* () {
      yield* grove.replaceOwners(stateOwners, [])
      const root = yield* grove.root(owner)
      if (root !== undefined) yield* grove.release(owner, root)
      yield* sql`DELETE FROM checkpoint_trees WHERE actor = ${actor}`
      yield* grove.collect
    }),
  }
})
