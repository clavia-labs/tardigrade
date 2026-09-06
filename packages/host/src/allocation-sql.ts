import { Clock, Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { ThreadCoordinate } from "@clavia/tardigrade-core/actor/coordinate"
import { actorEventKeyOf } from "@clavia/tardigrade-core/actor/events"
import type { Event } from "@clavia/tardigrade-core/event"
import { threadAllocationRecord, type ThreadAllocationStore } from "./allocation"

// sqlThreadDirectory records allocation in the existing actor log within a transaction (platform/bun/src/allocation.test.ts).
export const sqlThreadDirectory = (
  sql: SqlClient.SqlClient,
  table: "actor_events" | "events",
  occupied: (target: ThreadCoordinate, existingRoot: boolean) => Effect.Effect<boolean>
): ThreadAllocationStore => {
  const get = (key: string) => sql<{ thread: string }>`SELECT json_extract(event, '$.thread') AS thread
    FROM ${sql(table)} WHERE json_extract(event, '$.type') = 'ThreadAllocated'
    AND json_extract(event, '$.allocationKey') = ${key}`.pipe(
    Effect.map((rows) => rows[0]?.thread), Effect.orDie
  )
  return {
    get,
    claim: (key, target, existingRoot, request) => sql.withTransaction(Effect.gen(function* () {
      const found = yield* get(key)
      if (found !== undefined) return found
      const rows = yield* sql<{ seq: number; event: string }>`SELECT seq, event FROM ${sql(table)} ORDER BY seq`
      const record = threadAllocationRecord(rows.map((row) => JSON.parse(row.event) as Event),
        request, target, existingRoot, yield* Clock.currentTimeMillis)
      if (record?.event === undefined) return record?.thread
      if (yield* occupied(target, existingRoot)) return undefined
      const seq = Number(rows.at(-1)?.seq ?? 0) + 1
      yield* sql`INSERT INTO ${sql(table)} (seq, key, event)
        VALUES (${seq}, ${actorEventKeyOf(record.event)}, ${JSON.stringify(record.event)})`
      return record.thread
    })).pipe(Effect.orDie)
  }
}
