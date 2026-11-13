import { Schema } from "effect"
import { Rpc } from "effect/rpc"
import { Library, MethodDescription, MethodHints } from "../library"

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

const describe = Rpc.make("describe", {
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
  .annotate(MethodHints, { readOnlyHint: true, openWorldHint: false })

const search = Rpc.make("search", {
  payload: Schema.Struct({ query: Schema.NonEmptyString, type: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)), from: Schema.optionalKey(Schema.NullOr(Position)), through: Schema.optionalKey(Schema.NullOr(Position)), limit: Schema.optionalKey(Schema.NullOr(PositiveInt)) }),
  success: Schema.Struct({
    from: Position, through: Position, indexedThrough: Position, limit: PositiveInt, more: Schema.Boolean,
    hits: Schema.Array(Schema.Struct({ position: Position, type: Schema.NullOr(Schema.String), score: Schema.Finite, snippet: Schema.String, truncated: Schema.Boolean })),
    policy: Policy, indexPolicy: Schema.Struct({ batchSize: PositiveInt, maxTextBytes: PositiveInt, maxIndexEvents: PositiveInt, tokenizer: Schema.String }),
  }),
  error: Schema.String,
}).annotate(MethodDescription, "Search the calling thread's full event history using SQLite FTS5 MATCH syntax, including quoted phrases, AND, OR, NOT and prefix terms. Searches observed domain string values; private effect inputs are excluded. type optionally filters the event discriminator. from and through bound eligible matches, independently of maxScanEvents. Hits contain journal positions, event types, relevance scores and snippets; truncated reports additional character clipping. Lower scores rank first. indexedThrough reports the thread corpus used for ranking, which can extend beyond through after later searches. Use hit positions to retrieve complete events with query. more reports additional matches.")
  .annotate(MethodHints, { readOnlyHint: true, openWorldHint: false })

const query = Rpc.make("query", {
  payload: Schema.Struct({ sql: Schema.NonEmptyString, from: Schema.optionalKey(Schema.NullOr(Position)), through: Schema.optionalKey(Schema.NullOr(Position)) }),
  success: Schema.Struct({
    from: Position, through: Position, queryPolicy: Schema.Record(Schema.String, PositiveInt), readEvents: Position, readBytes: Position,
    text: Schema.String, truncated: Schema.Boolean, moreRows: Schema.Boolean, policy: Policy,
  }),
  error: Schema.String,
}).annotate(MethodDescription, "Execute one read-only SQLite SELECT over the event history. Use describe without a type to discover table columns and event types, then describe the relevant type to learn its JSON field schemas before constructing field predicates. event contains the domain event as JSON; record preserves the observed journal envelope. from and through bound the eligible history. Queries use a read-only WASM virtual table over that entire prefix. Functions require SQLite's SQLITE_INNOCUOUS flag on every overload; recursive CTEs are supported within the work limits. Only the events table is readable; connection changes and PRAGMAs are rejected. Work limits fail explicitly and never return partial aggregates. queryPolicy reports applied limits; readEvents and readBytes report bridge reads. Results contain columns and rows as JSON text, with explicit row and character truncation flags.")
  .annotate(MethodHints, { readOnlyHint: true, openWorldHint: false })

export const log = Library.make("log", describe, search, query)
