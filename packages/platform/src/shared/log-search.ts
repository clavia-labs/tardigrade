import { checkpointDigestSync, observeRecord, recordEvent, RuntimeError, journalCall, type JournalSearch, type JournalSearchResult, type Recorded } from "@clavia/tardigrade-core"
import { Effect } from "effect"
import { SqlError, type SqlClient } from "effect/sql"

export interface LogSearchIndexPolicy {
  readonly batchSize: number
  readonly maxIndexEvents: number
  readonly maxTextBytes: number
  readonly tokenizer: "unicode61" | "porter unicode61" | "trigram"
}

export const DEFAULT_LOG_SEARCH_INDEX_POLICY: LogSearchIndexPolicy = { batchSize: 64, maxIndexEvents: 4_096, maxTextBytes: 1_000_000, tokenizer: "unicode61" }

const encoder = new TextEncoder()

// eventText indexes observed domain string values, including decoded chunks (test/scenarios/log/lifecycle.ts).
function eventText(record: Recorded<object>, maxBytes: number): { readonly type: string | null; readonly text: string } {
  const event = recordEvent(observeRecord(record))
  const pending: unknown[] = [event], strings: string[] = []
  let bytes = 0
  while (pending.length) {
    const value = pending.pop()
    if (typeof value === "string") {
      bytes += encoder.encode(value).byteLength + (strings.length ? 1 : 0)
      if (bytes > maxBytes) throw new RuntimeError(`Search event exceeds maxTextBytes ${maxBytes}`)
      strings.push(value)
    } else if (value !== null && typeof value === "object") {
      const children = Object.values(value)
      for (let index = children.length - 1; index >= 0; index--) pending.push(children[index])
    }
  }
  return { type: event !== null && typeof event === "object" && "type" in event && typeof event.type === "string" ? event.type : null, text: strings.join("\n") }
}

// sqlLogSearch binds FTS5 searches to a journal's observed history (test/scenarios/log/lifecycle.ts).
export function sqlLogSearch<Event extends object>(options: {
  readonly actor: string
  readonly client: Effect.Effect<SqlClient.SqlClient, Error>
  readonly readPosition: Effect.Effect<number, Error>
  readonly readRecord: (sql: SqlClient.SqlClient, row: { seq: number; event: string }) => Effect.Effect<Recorded<Event>, Error>
  readonly transaction: <Value>(sql: SqlClient.SqlClient, work: Effect.Effect<Value, Error>) => Effect.Effect<Value, Error>
  readonly policy?: Partial<LogSearchIndexPolicy> | undefined
}) {
  const policy = { ...DEFAULT_LOG_SEARCH_INDEX_POLICY, ...options.policy }
  for (const name of ["batchSize", "maxIndexEvents", "maxTextBytes"] as const) if (!Number.isSafeInteger(policy[name]) || policy[name] < 1) throw new RuntimeError(`${name} must be a positive safe integer`)
  if (!["unicode61", "porter unicode61", "trigram"].includes(policy.tokenizer)) throw new RuntimeError("Unsupported search tokenizer")
  const table = `experimental_log_search_v2_${checkpointDigestSync(encoder.encode(JSON.stringify([options.actor, policy.tokenizer])))}`
  return (request: JournalSearch): Effect.Effect<JournalSearchResult, Error> => Effect.gen(function* () {
    for (const value of [request.limit, request.snippetChars, request.snippetTokens, request.maxQueryChars]) if (!Number.isSafeInteger(value) || value < 1) return yield* Effect.fail(new RuntimeError("Invalid search limit"))
    if (request.limit >= Number.MAX_SAFE_INTEGER || request.snippetTokens > 64 || !request.query.trim() || request.query.includes("\0") || request.query.length > request.maxQueryChars) return yield* Effect.fail(new RuntimeError("Search query exceeds its policy"))
    const head = yield* options.readPosition
    if (!Number.isSafeInteger(request.from) || !Number.isSafeInteger(request.to) || request.from < 0 || request.to < request.from || request.to > head) return yield* Effect.fail(new RuntimeError("Search range is outside the thread history"))
    const sql = yield* options.client
    yield* options.transaction(sql, Effect.gen(function* () {
      yield* sql`CREATE TABLE IF NOT EXISTS experimental_log_search_index (name TEXT PRIMARY KEY, position INTEGER NOT NULL) WITHOUT ROWID`
      yield* sql.unsafe(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(type UNINDEXED, text, tokenize='${policy.tokenizer}')`)
    }))
    let remaining = policy.maxIndexEvents
    while (true) {
      const done = yield* options.transaction(sql, Effect.gen(function* () {
        const progress = yield* sql<{ position: number }>`SELECT position FROM experimental_log_search_index WHERE name = ${table}`
        const from = progress[0]?.position ?? 0
        if (!Number.isSafeInteger(from) || from < 0 || from > head && from > (yield* options.readPosition)) return yield* Effect.fail(new RuntimeError("Invalid search index position"))
        if (from >= request.to) return true
        if (remaining === 0) return yield* Effect.fail(new RuntimeError(`Search index incomplete: indexedThrough ${from}, through ${request.to}, maxIndexEvents ${policy.maxIndexEvents}; retry with a new call ID to resume`))
        const to = Math.min(request.to, from + Math.min(policy.batchSize, remaining))
        const rows = yield* sql<{ seq: number; event: string }>`SELECT seq, event FROM experimental_events WHERE actor = ${options.actor} AND seq >= ${from} AND seq < ${to} ORDER BY seq`
        if (rows.length !== to - from) return yield* Effect.fail(new RuntimeError("Search index journal range is unavailable"))
        for (const [offset, row] of rows.entries()) {
          if (row.seq !== from + offset || typeof row.event !== "string") return yield* Effect.fail(new RuntimeError("Invalid search index journal sequence"))
          const record = yield* options.readRecord(sql, row)
          const document = yield* journalCall(() => eventText(record, policy.maxTextBytes))
          yield* sql.unsafe(`INSERT INTO ${table}(rowid, type, text) VALUES (?, ?, ?)`, [row.seq, document.type, document.text])
        }
        remaining -= rows.length
        yield* sql`INSERT INTO experimental_log_search_index (name, position) VALUES (${table}, ${to}) ON CONFLICT(name) DO UPDATE SET position = excluded.position`
        return to === request.to
      }))
      if (done) break
    }
    return yield* options.transaction(sql, Effect.gen(function* () {
      const progress = yield* sql<{ position: number }>`SELECT position FROM experimental_log_search_index WHERE name = ${table}`
      const rows = yield* sql.unsafe<{ position: number; type: string | null; score: number; snippet: string }>(`SELECT rowid AS position, type, bm25(${table}) AS score, substr(snippet(${table}, 1, '', '', '...', ?), 1, ?) AS snippet FROM ${table} WHERE ${table} MATCH ? AND rowid >= ? AND rowid < ? AND (? IS NULL OR type = ?) ORDER BY score, rowid LIMIT ?`, [request.snippetTokens, request.snippetChars + 1, request.query, request.from, request.to, request.type ?? null, request.type ?? null, request.limit + 1]).pipe(Effect.mapError(error => new RuntimeError(
        `FTS5 search failed: ${error.reason.cause instanceof Error ? error.reason.cause.message : error.message}. For literal text containing punctuation, use a double-quoted phrase, for example "some-term".`, { cause: error },
      )))
      return { hits: rows.slice(0, request.limit).map(row => ({ ...row, snippet: row.snippet.slice(0, request.snippetChars), truncated: row.snippet.length > request.snippetChars })), more: rows.length > request.limit, indexedThrough: progress[0]?.position ?? 0, indexPolicy: policy }
    }))
  }).pipe(Effect.mapError(error => SqlError.isSqlError(error)
    ? new RuntimeError(`Log search storage failed (${error.reason._tag}, ${error.reason.operation ?? "SQL"}): ${error.message}`, { cause: error })
    : RuntimeError.from(error)))
}
