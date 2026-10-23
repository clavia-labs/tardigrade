import { Context, Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import type { Atom } from "../atoms/atom"
import { EventLog, eventLogContext } from "../services/event-log"
import type { FamilyRecord, JournalFamily } from "../services/journal/family"
import type { ObservedRecord, RecordMetadata } from "../services/journal"
import { observeRecord } from "../runtime/event-source"
import { recordEvent, recordMetadata } from "../runtime/record"

export const DEFAULT_DURABLE_ATOM_LOG_PAGE_SIZE = 100
export const DEFAULT_DURABLE_ATOM_LOG_IDLE_TTL = 0
export const DEFAULT_DURABLE_ATOM_LOG_INDEX_VERSION = "1"

export interface LogCursor {
  readonly log: string
  readonly version: string
  readonly snapshot: number
  readonly from: number
  readonly to: number
  readonly order: "asc" | "desc"
  readonly position: number
}

export interface LogRangeOptions {
  readonly from?: number
  readonly to?: number
  readonly order?: "asc" | "desc"
  readonly after?: LogCursor
  readonly limit?: number
}

export interface LogPage<Row> {
  readonly rows: readonly { readonly position: number; readonly value: Row }[]
  readonly snapshot: number
  readonly next?: LogCursor
}

export interface DurableAtomLogOptions<Row, Event> {
  readonly name: string
  readonly input: Schema.Schema<Event>
  readonly schema: Schema.Schema<Row>
  readonly project: (event: NoInfer<Event>, metadata: RecordMetadata, position: number) => NoInfer<Row>
  readonly pageSize?: number
  readonly idleTTL?: number
  readonly indexVersion?: string
}

export interface DurableAtomLog<Row, Event> {
  readonly name: string
  readonly input: Schema.Schema<Event>
  readonly schema: Schema.Schema<Row>
  readonly pageSize: number
  readonly idleTTL: number
  readonly indexVersion: string
  readonly range: (options?: LogRangeOptions) => Atom<LogPage<Row>>
  readonly row: (position: number) => Atom<Row | undefined>
}

const validPosition = (value: number) => Number.isSafeInteger(value) && value >= 0
const validLimit = (value: number) => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER

// durableAtomLog projects one immutable row per matching record, ordered by journal position; continuation cursors pin their journal prefix (platform/test/properties/log.ts).
export function durableAtomLog<Row, Event>(options: DurableAtomLogOptions<Row, Event>): DurableAtomLog<Row, Event> {
  const { name, input, schema, project } = options
  const pageSize = options.pageSize ?? DEFAULT_DURABLE_ATOM_LOG_PAGE_SIZE
  const idleTTL = options.idleTTL ?? DEFAULT_DURABLE_ATOM_LOG_IDLE_TTL
  const indexVersion = options.indexVersion ?? DEFAULT_DURABLE_ATOM_LOG_INDEX_VERSION
  if (!name.trim() || !indexVersion.trim()) throw new Error("Log name and indexVersion must be nonempty")
  if (!validLimit(pageSize)) throw new Error("Log page size must be a positive safe integer with room for lookahead")
  if (!(idleTTL >= 0) || (idleTTL !== Infinity && !Number.isFinite(idleTTL))) throw new Error("Log idleTTL must be nonnegative milliseconds or Infinity")
  const accepts = Schema.is(input)
  const decode = Schema.decodeUnknownSync(Schema.toType(schema), { onExcessProperty: "error" })
  const family: JournalFamily = { name: JSON.stringify(["log", name]), indexVersion, key: record => accepts(recordEvent(observeRecord(record))) ? "rows" : undefined }
  const pages = NativeAtom.family((identity: string): Atom<LogPage<Row>> => {
    const query = JSON.parse(identity) as LogRangeOptions
    return Object.assign(NativeAtom.readable(get => {
      const context = get(eventLogContext)
      if (!context) throw new Error("Missing EventLog service")
      const replay = get(Context.get(context, EventLog).replay)
      const cursor = query.after
      const snapshot = cursor?.snapshot ?? replay.position
      const from = cursor?.from ?? query.from ?? 0
      const to = cursor?.to ?? query.to ?? snapshot
      const order = cursor?.order ?? query.order ?? "asc"
      const limit = query.limit ?? pageSize
      if (!validPosition(snapshot) || snapshot > replay.position || !validPosition(from) || !validPosition(to) || from > to || to > snapshot) throw new Error("Log range is outside its journal prefix")
      if (cursor && (cursor.log !== name || cursor.version !== indexVersion || !validPosition(cursor.position) || cursor.position < from || cursor.position >= to || (query.from !== undefined && query.from !== from) || (query.to !== undefined && query.to !== to) || (query.order !== undefined && query.order !== order))) throw new Error("Log cursor does not belong to this range")
      const lower = order === "asc" && cursor ? cursor.position + 1 : from
      const upper = order === "desc" && cursor ? cursor.position : to
      const records = replay.readFamily ? replay.readFamily(family, "rows", lower, { to: upper, order }) : (function* (): Iterable<FamilyRecord<ObservedRecord<unknown>>> {
        const history = replay.read(0)
        for (let index = lower; index < upper; index++) {
          const position = order === "asc" ? index : upper - (index - lower) - 1
          const record = history.at(position)!
          if (family.key(record, position) === "rows") yield { position, record }
        }
      })()
      const rows: Array<{ readonly position: number; readonly value: Row }> = []
      let previous = order === "asc" ? lower - 1 : upper
      let more = false
      for (const entry of records) {
        if (!validPosition(entry.position) || entry.position < lower || entry.position >= upper || (order === "asc" ? entry.position <= previous : entry.position >= previous)) throw new Error("Log index returned invalid row positions")
        previous = entry.position
        const event = recordEvent(entry.record)
        if (!accepts(event)) throw new Error("Log index differs from its journal record")
        if (rows.length === limit) { more = true; break }
        rows.push({ position: entry.position, value: decode(project(event, recordMetadata(entry.record), entry.position)) })
      }
      return { rows, snapshot, ...(more ? { next: { log: name, version: indexVersion, snapshot, from, to, order, position: rows[rows.length - 1]!.position } } : {}) }
    }).pipe(NativeAtom.setIdleTTL(idleTTL)), { input })
  })
  const range = (query: LogRangeOptions = {}) => {
    if ((query.from !== undefined && !validPosition(query.from)) || (query.to !== undefined && !validPosition(query.to))) throw new Error("Log bounds must be nonnegative safe integers")
    if (query.after && (![query.after.snapshot, query.after.from, query.after.to, query.after.position].every(validPosition) || query.after.log !== name || query.after.version !== indexVersion)) throw new Error("Log cursor does not belong to this range")
    if (!validLimit(query.limit ?? pageSize)) throw new Error("Log page limit must be a positive safe integer with room for lookahead")
    if (query.order !== undefined && query.order !== "asc" && query.order !== "desc") throw new Error("Log order must be asc or desc")
    if (query.after && query.after.order !== "asc" && query.after.order !== "desc") throw new Error("Log cursor order must be asc or desc")
    return pages(JSON.stringify(query))
  }
  const members = NativeAtom.family((position: number): Atom<Row | undefined> => Object.assign(NativeAtom.readable(get => {
    const context = get(eventLogContext)
    if (!context) throw new Error("Missing EventLog service")
    const replay = get(Context.get(context, EventLog).replay)
    return position >= replay.position ? undefined : get(range({ from: position, to: position + 1, limit: 1 })).rows[0]?.value
  }).pipe(NativeAtom.setIdleTTL(idleTTL)), { input }))
  return { name, input, schema, pageSize, idleTTL, indexVersion, range, row: position => {
    if (!validPosition(position) || position >= Number.MAX_SAFE_INTEGER) throw new Error("Log row position must be a nonnegative safe integer with room for its upper bound")
    return members(position)
  } }
}
