import { Context, Effect, Layer, Schema, SchemaAST } from "effect"
import { historicalEventDecoder } from "../event/versioned"
import { recordEvent } from "../runtime/record"
import { RuntimeError } from "../runtime/effects"
import type { JournalFamily, ReadJournalFamily } from "../services/journal/family"
import type { Recorded } from "../services/journal"

export const DEFAULT_LOG_PAGE_SIZE = 100
export const DEFAULT_LOG_READ_BATCH_SIZE = 128

const Position = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Events = Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1), Schema.makeFilter(events => events.every((event, index) => index === 0 || events[index - 1]! < event), { title: "Sorted distinct event keys" }))

export const LogSelection = Schema.Struct({ events: Events, from: Position, to: Position }).check(Schema.makeFilter(range => range.from <= range.to, { title: "Ordered log bounds" }))
declare const RowType: unique symbol
export type LogSelection<Row = unknown> = typeof LogSelection.Type & { readonly [RowType]?: Row }

export const LogReadCursor = Schema.Struct({ events: Events, from: Position, to: Position, order: Schema.Literals(["asc", "desc"]), position: Position })
export type LogReadCursor = typeof LogReadCursor.Type

export interface LogReadOptions {
  readonly limit?: number
  readonly order?: "asc" | "desc"
  readonly after?: LogReadCursor
}

export interface LogReadPage<Row> {
  readonly rows: readonly { readonly position: number; readonly value: Row }[]
  readonly snapshot: number
  readonly next?: LogReadCursor
}

export interface LogView<Row> {
  readonly events: readonly string[]
  readonly Range: Schema.Codec<LogSelection<Row>>
  readonly range: (bounds: { readonly from: number; readonly to: number }) => LogSelection<Row>
}

export interface LogSource {
  readonly readPosition: () => number
  readonly readRange: (from: number, to: number) => readonly Recorded<unknown>[]
  readonly readFamily?: ReadJournalFamily<unknown>
}

export class LogReader extends Context.Service<LogReader, { readonly source: () => LogSource }>()("experimental/LogReader") {}

export interface TypedLog<Event extends { readonly type: string }> {
  readonly schema: Schema.Schema<Event>
  readonly pageSize: number
  readonly readBatchSize: number
  readonly view: <const Key extends Event["type"]>(events: Key | readonly Key[]) => LogView<Extract<Event, { readonly type: Key }>>
  readonly read: <Row extends Event>(selection: LogSelection<Row>, options?: LogReadOptions) => Effect.Effect<LogReadPage<Row>, RuntimeError, LogReader>
}

type Reader = (source: LogSource, selection: LogSelection, options: LogReadOptions) => LogReadPage<unknown>
const readers = new WeakMap<object, Reader>()
const viewReaders = new WeakMap<object, Reader>()
const viewSchemas = new WeakMap<object, Schema.Top>()
const isSelection = Schema.is(LogSelection)
const isCursor = Schema.is(LogReadCursor)
const validPosition = (value: number) => Number.isSafeInteger(value) && value >= 0
const sameEvents = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((event, index) => event === b[index])
const eventType = (record: Recorded<unknown>) => {
  const event = recordEvent(record)
  return typeof event === "object" && event !== null && "type" in event && typeof event.type === "string" ? event.type : undefined
}
const family: JournalFamily = { name: "experimental/log/event-types", indexVersion: "1", key: eventType }

function eventKeys(ast: SchemaAST.AST): readonly string[] {
  if (SchemaAST.isUnion(ast)) return ast.types.flatMap(eventKeys)
  if (!SchemaAST.isObjects(ast)) throw new RuntimeError("Log events require literal type discriminators")
  const type = ast.propertySignatures.find(field => field.name === "type")?.type
  if (!type || !SchemaAST.isLiteral(type) || typeof type.literal !== "string" || !type.literal.trim()) throw new RuntimeError("Log events require literal type discriminators")
  return [type.literal]
}

// createLog selects typed event keys and reads fixed ranges from a supplied local source without reactive state (platform/test/properties/log.ts, logViews).
export function createLog<Event extends { readonly type: string }>(options: { readonly schema: Schema.Schema<Event>; readonly pageSize?: number; readonly readBatchSize?: number }): TypedLog<Event> {
  const pageSize = options.pageSize ?? DEFAULT_LOG_PAGE_SIZE
  const readBatchSize = options.readBatchSize ?? DEFAULT_LOG_READ_BATCH_SIZE
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize >= Number.MAX_SAFE_INTEGER) throw new RuntimeError("Log page size must be a positive safe integer with room for lookahead")
  if (!Number.isSafeInteger(readBatchSize) || readBatchSize < 1) throw new RuntimeError("Log readBatchSize must be a positive safe integer")
  const keys = new Set(eventKeys(Schema.toType(options.schema).ast))
  const decode = historicalEventDecoder(options.schema)
  const views = new Map<string, LogView<Event>>()
  const accepts = (selection: LogSelection) => isSelection(selection) && selection.events.every(key => keys.has(key))

  const read: Reader = (source, selection, query) => {
    if (!accepts(selection)) throw new RuntimeError("Invalid log selection or unknown event key")
    const limit = query.limit ?? pageSize
    if (!Number.isSafeInteger(limit) || limit < 1 || limit >= Number.MAX_SAFE_INTEGER) throw new RuntimeError("Log page limit must be a positive safe integer with room for lookahead")
    const position = source.readPosition()
    if (!validPosition(position) || selection.to > position) throw new RuntimeError("Log selection is outside its source prefix")
    const cursor = query.after
    const order = query.order ?? cursor?.order ?? "asc"
    if (order !== "asc" && order !== "desc") throw new RuntimeError("Invalid log read order")
    if (cursor && (!isCursor(cursor) || !sameEvents(cursor.events, selection.events) || cursor.from !== selection.from || cursor.to !== selection.to || cursor.order !== order || cursor.position < selection.from || cursor.position >= selection.to)) throw new RuntimeError("Log cursor does not belong to this selection")
    const from = order === "asc" && cursor ? cursor.position + 1 : selection.from
    const to = order === "desc" && cursor ? cursor.position : selection.to
    const selected = new Set(selection.events)
    type Entry = { readonly position: number; readonly record: Recorded<unknown> }
    const records: Iterable<Entry> = source.readFamily ? {
      *[Symbol.iterator]() {
        const iterators = selection.events.map(key => source.readFamily!(family, key, from, to, order)[Symbol.iterator]())
        const heads = iterators.map(iterator => iterator.next())
        try {
          while (true) {
            let index = -1
            for (let i = 0; i < heads.length; i++) {
              const head = heads[i]!
              if (!head.done && (index === -1 || (order === "asc" ? head.value.position < heads[index]!.value.position : head.value.position > heads[index]!.value.position))) index = i
            }
            if (index === -1) return
            yield heads[index]!.value
            heads[index] = iterators[index]!.next()
          }
        } finally { for (const iterator of iterators) iterator.return?.() }
      },
    } : {
      *[Symbol.iterator]() {
        let at = order === "asc" ? from : to
        while (order === "asc" ? at < to : at > from) {
          const lower = order === "asc" ? at : Math.max(from, at - readBatchSize)
          const upper = order === "asc" ? Math.min(to, at + readBatchSize) : at
          const batch = source.readRange(lower, upper)
          if (batch.length !== upper - lower) throw new RuntimeError("Log history is unavailable")
          for (let i = 0; i < batch.length; i++) {
            const index = order === "asc" ? i : batch.length - i - 1
            const record = batch[index]!
            if (selected.has(eventType(record) ?? "")) yield { position: lower + index, record }
          }
          at = order === "asc" ? upper : lower
        }
      },
    }
    const rows: Array<{ readonly position: number; readonly value: Event }> = []
    let previous = order === "asc" ? from - 1 : to
    for (const entry of records) {
      if (!validPosition(entry.position) || entry.position < from || entry.position >= to || (order === "asc" ? entry.position <= previous : entry.position >= previous) || !selected.has(eventType(entry.record) ?? "")) throw new RuntimeError("Log index returned invalid records")
      previous = entry.position
      if (rows.length === limit) return { rows, snapshot: selection.to, next: { ...selection, order, position: rows[rows.length - 1]!.position } }
      rows.push({ position: entry.position, value: decode(recordEvent(entry.record)) })
    }
    return { rows, snapshot: selection.to }
  }

  const log: TypedLog<Event> = {
    schema: options.schema, pageSize, readBatchSize,
    view: <const Key extends Event["type"]>(events: Key | readonly Key[]): LogView<Extract<Event, { readonly type: Key }>> => {
      const selected = [...new Set(typeof events === "string" ? [events] : events)].sort()
      if (!selected.length || selected.some(key => !keys.has(key))) throw new RuntimeError("Unknown log event key")
      const identity = JSON.stringify(selected)
      let view = views.get(identity)
      if (!view) {
        const Range = LogSelection.check(Schema.makeFilter(selection => sameEvents(selection.events, selected), { title: "Matching log event keys" }))
        const parse = Schema.decodeSync(Range)
        const frozen = Object.freeze(selected)
        view = { events: frozen, Range, range: bounds => Object.freeze({ ...parse({ events: frozen, ...bounds }), events: frozen }) }
        views.set(identity, view)
        viewReaders.set(view, read)
        viewSchemas.set(view, options.schema)
      }
      return view as LogView<Extract<Event, { readonly type: Key }>>
    },
    read: <Row extends Event>(selection: LogSelection<Row>, query: LogReadOptions = {}) => Effect.gen(function* () {
      const reader = yield* LogReader
      return yield* Effect.try({ try: () => readLogPage(log, reader.source(), selection, query), catch: RuntimeError.from })
    }),
  }
  readers.set(log, read)
  return log
}

// readLogPage supplies the synchronous local read used by adapters (platform/test/properties/log.ts, logViews).
export function readLogPage<Event extends { readonly type: string }, Row extends Event>(log: TypedLog<Event>, source: LogSource, selection: LogSelection<Row>, options: LogReadOptions = {}): LogReadPage<Row> {
  const read = readers.get(log)
  if (!read) throw new RuntimeError("Unknown log definition")
  return read(source, selection, options) as LogReadPage<Row>
}

// readLogViewPage validates a view's event keys before delegating to its source reader (platform/test/properties/log.ts, logViews).
export function readLogViewPage<Row>(view: LogView<Row>, source: LogSource, selection: LogSelection<Row>, options: LogReadOptions): LogReadPage<Row> {
  const read = viewReaders.get(view)
  if (!read || !sameEvents(view.events, selection.events)) throw new RuntimeError("Unknown log view or mismatched selection")
  return read(source, selection, options) as LogReadPage<Row>
}

// logViewSchema supplies the journal's registered event schema to reactive adapters.
export function logViewSchema(view: object): Schema.Top {
  const schema = viewSchemas.get(view)
  if (!schema) throw new RuntimeError("Unknown log view")
  return schema
}

// Log provides event-key views and an Effect source layer over an existing actor journal.
export const Log = {
  make: createLog,
  layer: (source: LogSource | (() => LogSource)) => Layer.succeed(LogReader, { source: typeof source === "function" ? source : () => source }),
}
