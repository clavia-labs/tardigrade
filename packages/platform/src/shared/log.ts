import { Effect, Layer } from "effect"
import { EventLog } from "@clavia/tardigrade-core"
import { log, DEFAULT_LOG_POLICY, type LogPolicy } from "@clavia/tardigrade-libraries/log/index"
import { clipText, describeLog } from "@clavia/tardigrade-libraries/log/discovery"

// journal implements the log library using the current thread's EventLog.
export function journal(options: Partial<LogPolicy> = {}) {
  const policy = { ...DEFAULT_LOG_POLICY, ...options }
  for (const [name, value] of Object.entries(policy)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  if (policy.maxSnippetTokens > 64) throw new Error("maxSnippetTokens must be at most SQLite FTS5's 64-token limit")
  return Layer.effect(log, Effect.map(EventLog, service => ({
    describe: input => Effect.try({ try: () => describeLog(service, input, policy), catch: String }),
    search: input => Effect.gen(function* () {
      if (!service.search) return yield* Effect.fail("This event log does not support full-text search")
      if (input.query.length > policy.maxQueryChars) return yield* Effect.fail(`Search exceeds maxQueryChars ${policy.maxQueryChars}`)
      const snapshot = yield* Effect.try({ try: () => service.snapshot(), catch: String })
      const from = input.from ?? 0, through = input.through ?? snapshot.position
      if (from > through || through > snapshot.position) return yield* Effect.fail("Search range is outside the current thread's history")
      const limit = Math.min(input.limit ?? policy.maxResults, policy.maxResults)
      const result = yield* service.search({ ...(input.type ? { type: input.type } : {}), query: input.query, from, to: through, limit, snippetChars: policy.maxRecordChars, snippetTokens: policy.maxSnippetTokens, maxQueryChars: policy.maxQueryChars }).pipe(Effect.mapError(String))
      return { ...result, from, through, limit, policy }
    }),
    query: input => Effect.gen(function* () {
      const log = service
      if (!log.query) return yield* Effect.fail("This event log does not support SQL queries")
      if (input.sql.length > policy.maxQueryChars) return yield* Effect.fail(`SQL exceeds maxQueryChars ${policy.maxQueryChars}`)
      const snapshot = yield* Effect.try({ try: () => log.snapshot(), catch: String })
      const from = input.from ?? 0
      const through = input.through ?? snapshot.position
      if (from > through || through > snapshot.position) return yield* Effect.fail("Recall range is outside the current thread's history")
      const result = yield* log.query({ sql: input.sql, from, to: through, limit: policy.maxResults }).pipe(Effect.mapError(String))
      const text = JSON.stringify({ columns: result.columns, rows: result.rows })
      return {
        from, through, queryPolicy: result.queryPolicy, readEvents: result.readEvents, readBytes: result.readBytes,
        ...clipText(text, policy.maxRecordChars),
        moreRows: result.more, policy,
      }
    }),
  })))
}
