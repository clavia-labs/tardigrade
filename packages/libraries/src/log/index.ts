import { clipText, describeLog } from "./discovery"
import { EventLog } from "@clavia/tardigrade-core"
import { Effect, Schema } from "effect"
import { Rpc } from "effect/rpc"
import { defineLibrary, MethodDescription, MethodHints } from "../library"

export interface LogPolicy {
  readonly maxResults: number
  readonly maxScanEvents: number
  readonly maxRecordChars: number
  readonly maxSamples: number
  readonly maxQueryChars: number
  readonly maxSnippetTokens: number
}

export const DEFAULT_LOG_POLICY: LogPolicy = { maxResults: 20, maxScanEvents: 500, maxRecordChars: 4_096, maxSamples: 2, maxQueryChars: 8_192, maxSnippetTokens: 24 }

const Position = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Policy = Schema.Struct({ maxResults: PositiveInt, maxScanEvents: PositiveInt, maxRecordChars: PositiveInt, maxSamples: PositiveInt, maxQueryChars: PositiveInt, maxSnippetTokens: PositiveInt })
const ClippedText = Schema.Struct({ text: Schema.String, truncated: Schema.Boolean })

export const log = defineLibrary({
  name: "log",
  description: "Discover and query the current thread's durable event history, including information outside the conversation context.",
  toolNames: { describe: "recall_describe", query: "recall_sql", search: "recall_search" },
  methods: [
    Rpc.make("describe", {
      payload: Schema.Struct({ type: Schema.optionalKey(Schema.NullOr(Schema.String)), cursor: Schema.optionalKey(Schema.NullOr(Position)), limit: Schema.optionalKey(Schema.NullOr(PositiveInt)) }),
      success: Schema.Struct({
        table: Schema.Struct({ name: Schema.String, columns: Schema.Record(Schema.String, Schema.String) }),
        position: Position, declarationsAvailable: Schema.Boolean, observedThrough: Position, observedComplete: Schema.Boolean,
        types: Schema.Array(Schema.Struct({
          type: Schema.Union([Schema.String, Schema.Null]), declared: Schema.Boolean, observedCount: Position,
          schemas: Schema.Array(ClippedText), fields: Schema.Record(Schema.String, Schema.Array(Schema.String)),
          samples: Schema.Array(Schema.Struct({ position: Position, ...ClippedText.fields })),
        })),
        totalTypes: Position, nextCursor: Schema.Union([Position, Schema.Null]), limit: PositiveInt, policy: Policy,
      }),
      error: Schema.String,
    }).annotate(MethodDescription, "Discover SQL table columns and event types. Omit type, or pass an empty string, for a paginated inventory; pass null for untagged events or provide an event type to retrieve its current declared JSON Schemas, observed field kinds, and sample records. Declarations and observed shapes are separate; historical events may differ. observedThrough and observedComplete bound the observed evidence. Continue inventories with nextCursor as cursor. Schemas and samples report text truncation.")
      .annotate(MethodHints, { readOnlyHint: true, openWorldHint: false }),
    Rpc.make("search", {
      payload: Schema.Struct({ query: Schema.NonEmptyString, type: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)), from: Schema.optionalKey(Schema.NullOr(Position)), through: Schema.optionalKey(Schema.NullOr(Position)), limit: Schema.optionalKey(Schema.NullOr(PositiveInt)) }),
      success: Schema.Struct({
        from: Position, through: Position, indexedThrough: Position, limit: PositiveInt, more: Schema.Boolean,
        hits: Schema.Array(Schema.Struct({ position: Position, type: Schema.NullOr(Schema.String), score: Schema.Finite, snippet: Schema.String, truncated: Schema.Boolean })),
        policy: Policy, indexPolicy: Schema.Struct({ batchSize: PositiveInt, maxTextBytes: PositiveInt, maxIndexEvents: PositiveInt, tokenizer: Schema.String }),
      }),
      error: Schema.String,
    }).annotate(MethodDescription, "Search the calling thread's full event history using SQLite FTS5 MATCH syntax, including quoted phrases, AND, OR, NOT and prefix terms. Searches observed domain string values; private effect inputs are excluded. type optionally filters the event discriminator. from and through bound eligible matches, independently of maxScanEvents. Hits contain journal positions, event types, relevance scores and snippets; truncated reports additional character clipping. Lower scores rank first. indexedThrough reports the thread corpus used for ranking, which can extend beyond through after later searches. Use hit positions to retrieve complete events with query. more reports additional matches.")
      .annotate(MethodHints, { readOnlyHint: true, openWorldHint: false }),
    Rpc.make("query", {
      payload: Schema.Struct({ sql: Schema.NonEmptyString, from: Schema.optionalKey(Schema.NullOr(Position)), through: Schema.optionalKey(Schema.NullOr(Position)) }),
      success: Schema.Struct({
        from: Position, through: Position, queryPolicy: Schema.Record(Schema.String, PositiveInt), readEvents: Position, readBytes: Position,
        text: Schema.String, truncated: Schema.Boolean, moreRows: Schema.Boolean, policy: Policy,
      }),
      error: Schema.String,
    }).annotate(MethodDescription, "Execute one read-only SQLite SELECT over the event history. Use describe without a type to discover table columns and event types, then describe the relevant type to learn its JSON field schemas before constructing field predicates. event contains the domain event as JSON; record preserves the observed journal envelope. from and through bound the eligible history. Queries use a read-only WASM virtual table over that entire prefix. Functions require SQLite's SQLITE_INNOCUOUS flag on every overload; recursive CTEs are supported within the work limits. Only the events table is readable; connection changes and PRAGMAs are rejected. Work limits fail explicitly and never return partial aggregates. queryPolicy reports applied limits; readEvents and readBytes report bridge reads. Results contain columns and rows as JSON text, with explicit row and character truncation flags.")
      .annotate(MethodHints, { readOnlyHint: true, openWorldHint: false }),
  ],
})

// logTools supplies schema discovery, text search, and SQL queries over the calling thread's EventLog.
export function logTools(options: Partial<LogPolicy> = {}) {
  const policy = { ...DEFAULT_LOG_POLICY, ...options }
  for (const [name, value] of Object.entries(policy)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  if (policy.maxSnippetTokens > 64) throw new Error("maxSnippetTokens must be at most SQLite FTS5's 64-token limit")
  return log.implement({
    describe: input => EventLog.use(log => Effect.try({ try: () => describeLog(log, input, policy), catch: String })),
    search: input => Effect.gen(function* () {
      const service = yield* EventLog
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
      const log = yield* EventLog
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
  })
}
