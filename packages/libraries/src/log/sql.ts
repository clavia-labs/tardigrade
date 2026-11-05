import { Context, Effect, Schema } from "effect"
import type { ObservedRecord } from "@clavia/tardigrade-core"

// LogSqlError preserves query rejection and execution failures at the SQL capability boundary.
export class LogSqlError extends Error {
  readonly _tag = "LogSqlError"
  static from(cause: unknown): LogSqlError {
    return cause instanceof LogSqlError ? cause : new LogSqlError(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}

export interface LogSqlPolicy {
  readonly timeoutMs: number
  readonly maxQueryChars: number
  readonly maxSnapshotChars: number
}

export interface LogSqlRequest {
  readonly sql: string
  readonly from: number
  readonly records: readonly ObservedRecord<unknown>[]
  readonly limit: number
}

export const LogSqlResult = Schema.Struct({
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(Schema.Json)),
  more: Schema.Boolean,
})

// LogSql executes queries against a supplied thread snapshot without access to its journal connection.
export class LogSql extends Context.Service<LogSql, {
  readonly policy: LogSqlPolicy
  readonly query: (request: LogSqlRequest) => Effect.Effect<typeof LogSqlResult.Type, LogSqlError>
}>()("tardie/LogSql") {}
