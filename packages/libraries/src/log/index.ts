import { describeLog } from "./discovery"
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
}

export const DEFAULT_LOG_POLICY: LogPolicy = { maxResults: 20, maxScanEvents: 500, maxRecordChars: 4_096, maxSamples: 2, maxQueryChars: 8_192 }

const Position = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Policy = Schema.Struct({ maxResults: PositiveInt, maxScanEvents: PositiveInt, maxRecordChars: PositiveInt, maxSamples: PositiveInt, maxQueryChars: PositiveInt })
const ClippedText = Schema.Struct({ text: Schema.String, truncated: Schema.Boolean })

export const log = defineLibrary({
  name: "log",
  description: "Discover and query the current thread's durable event history, including information outside the conversation context.",
  toolNames: { describe: "recall_describe", query: "recall_sql" },
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
    }).annotate(MethodDescription, "Discover SQL table columns and event types. Omit type, or pass null or an empty string, for a paginated inventory; provide an event type to retrieve its current declared JSON Schemas, observed field kinds, and sample records. Declarations and observed shapes are separate; historical events may differ. observedThrough and observedComplete bound the observed evidence. Continue inventories with nextCursor as cursor. Schemas and samples report text truncation.")
      .annotate(MethodHints, { readOnlyHint: true, openWorldHint: false }),
    Rpc.make("query", {
      payload: Schema.Struct({ sql: Schema.NonEmptyString, from: Schema.optionalKey(Schema.NullOr(Position)), through: Schema.optionalKey(Schema.NullOr(Position)) }),
      success: Schema.Struct({
        from: Position, through: Position, scannedThrough: Position, next: Schema.Union([Position, Schema.Null]),
        text: Schema.String, truncated: Schema.Boolean, moreRows: Schema.Boolean, policy: Policy,
      }),
      error: Schema.String,
    }).annotate(MethodDescription, "Execute one read-only SQLite SELECT over the event history. Use describe without a type to discover table columns and event types, then describe the relevant type to learn its JSON field schemas before constructing field predicates. event contains the domain event as JSON; record preserves the observed journal envelope. The bounded input window is reported as from and scannedThrough; next continues the window. Aggregates cover only that window. Results contain columns and rows as JSON text, with explicit row and character truncation flags.")
      .annotate(MethodHints, { readOnlyHint: true, openWorldHint: false }),
  ],
})

// logTools supplies schema discovery and SQL queries over the calling thread's EventLog.
export function logTools(options: Partial<LogPolicy> = {}) {
  const policy = { ...DEFAULT_LOG_POLICY, ...options }
  for (const [name, value] of Object.entries(policy)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  return log.implement({
    describe: input => EventLog.use(log => Effect.try({ try: () => describeLog(log, input, policy), catch: String })),
    query: input => Effect.gen(function* () {
      const log = yield* EventLog
      if (!log.query) return yield* Effect.fail("This event log does not support SQL queries")
      if (input.sql.length > policy.maxQueryChars) return yield* Effect.fail(`SQL exceeds maxQueryChars ${policy.maxQueryChars}`)
      const snapshot = yield* Effect.try({ try: () => log.snapshot(), catch: String })
      const from = input.from ?? 0
      const through = input.through ?? snapshot.position
      if (from > through || through > snapshot.position) return yield* Effect.fail("Recall range is outside the current thread's history")
      const scannedThrough = Math.min(through, from + policy.maxScanEvents)
      const result = yield* log.query({ sql: input.sql, from, to: scannedThrough, limit: policy.maxResults }).pipe(Effect.mapError(String))
      const text = JSON.stringify({ columns: result.columns, rows: result.rows })
      return {
        from, through, scannedThrough, next: scannedThrough < through ? scannedThrough : null,
        text: text.slice(0, policy.maxRecordChars), truncated: text.length > policy.maxRecordChars,
        moreRows: result.more, policy,
      }
    }),
  })
}
