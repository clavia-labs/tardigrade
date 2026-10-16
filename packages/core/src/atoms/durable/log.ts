import { Schema } from "effect"
import { durableProjection } from "./projection"
import { incrementalValidator, invalid } from "../incremental/validate"
import type { DurableAtom } from "./atom"
import type { RecordMetadata } from "../../services/journal"
import { logSelection, type LogStorage, type LogSelection } from "../../services/log-state"
import type { EventLog } from "../../services/event-log"

// LOG_CHUNK is the default number of entries in a shared log chunk.
export const LOG_CHUNK = 32
// DEFAULT_LOG_CACHE_CHUNKS bounds how many stored chunks a restored log keeps decoded; reads beyond it load from storage again.
export const DEFAULT_LOG_CACHE_CHUNKS = 256

// StoredPrefix is a log's stored entries [0, length), read from storage on demand.
interface StoredPrefix<Entry> { readonly length: number; readonly at: (index: number) => Entry }
function storedPrefix<Entry>(name: string, length: number, storage: LogStorage, cacheChunks: number, chunkItems: number): StoredPrefix<Entry> {
  const cache = new Map<number, readonly Entry[]>()
  return {
    length,
    at: (index: number) => {
      const chunk = Math.floor(index / chunkItems)
      let entries = cache.get(chunk)
      if (entries) { cache.delete(chunk); cache.set(chunk, entries) }
      else {
        // Stored rows were validated entries when written, so loading freezes them without validating again.
        const start = chunk * chunkItems, end = Math.min(length, (chunk + 1) * chunkItems)
        entries = storage.load(name, start, end).map(value => deepFreeze(value as Entry))
        if (entries.length !== end - start) throw new Error(`Log ${name} stores ${entries.length} of entries [${start}, ${end})`)
        cache.set(chunk, entries)
        while (cache.size > cacheChunks) cache.delete(cache.keys().next().value!)
      }
      return entries[index % chunkItems]!
    },
  }
}

// Log is an append-only sequence. Versions share frozen chunks, so earlier versions stay valid and a range of a version never changes; restart begins a new generation for histories that replace their prefix.
export interface Log<Entry> {
  readonly name: string
  readonly length: number
  readonly at: (index: number) => Entry
  readonly slice: (start: number, end: number) => readonly Entry[]
  readonly append: (values: readonly Entry[]) => Log<Entry>
  readonly restart: (values: readonly Entry[]) => Log<Entry>
  // select names the range [start, end) of this generation, optionally projected through each, as an act input.
  select(start: number, end: number): LogSelection<readonly Entry[]>
  select(start: number, end: number, each: readonly (string | number)[]): LogSelection<readonly unknown[]>
}

// persistent holds log versions whose runtime stores entries, so their checkpoint state records only a length.
const persistent = new WeakSet<object>()
const frozen = new WeakSet<object>()
const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !frozen.has(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
    frozen.add(value)
  }
  return value
}

function makeLog<Entry>(atom: string, generation: number, chunkItems: number, prefix: StoredPrefix<Entry> | undefined, chunks: readonly (readonly Entry[])[], tail: readonly Entry[], accept: (value: Entry) => Entry, onCreate: (log: Log<Entry>, parent?: Log<Entry>) => void, parent?: Log<Entry>): Log<Entry> {
  const base = prefix?.length ?? 0
  const length = base + chunks.length * chunkItems + tail.length
  const name = `${atom}#${generation}`
  const at = (index: number): Entry => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= length) throw new RangeError(`Log index ${index} is outside ${name} of length ${length}`)
    if (index < base) return prefix!.at(index)
    const chunk = Math.floor((index - base) / chunkItems)
    return chunk < chunks.length ? chunks[chunk]![(index - base) % chunkItems]! : tail[index - base - chunks.length * chunkItems]!
  }
  const log: Log<Entry> = Object.freeze({
    name, length, at,
    slice: (start: number, end: number) => {
      const from = Math.max(0, Math.min(start, length)), to = Math.max(from, Math.min(end, length))
      const values: Entry[] = []
      for (let index = from; index < to; index++) values.push(at(index))
      return Object.freeze(values)
    },
    append: (values: readonly Entry[]) => {
      if (!values.length) return log
      let nextChunks = chunks
      let nextTail = tail
      for (const value of values) {
        const grown = [...nextTail, accept(value)]
        if (grown.length === chunkItems) { nextChunks = [...nextChunks, Object.freeze(grown)]; nextTail = [] } else nextTail = grown
      }
      return makeLog(atom, generation, chunkItems, prefix, nextChunks, Object.freeze(nextTail), accept, onCreate, log)
    },
    restart: (values: readonly Entry[]) => makeLog<Entry>(atom, generation + 1, chunkItems, undefined, [], [], accept, onCreate).append(values),
    select: (start: number, end: number, each?: readonly (string | number)[]) => {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end > length) throw new RangeError(`Log selection [${start}, ${end}) is outside ${name} of length ${length}`)
      return logSelection<readonly Entry[]>({ log: name, start, end, ...(each ? { each } : {}) })
    },
  })
  onCreate(log, parent)
  return log
}

/*
const history = durableLogAtom({
  name: "example.history",
  entry: Message,                                        // entry schema
  meta: { schema: Cursor, initial: { read: 0 } },        // small header state
  input: Received,
  reduce: ({ log, meta }, event) => ({ log: log.append([event.message]), meta }),
})
*/

// durableLogAtom folds events into an append-only log plus a small header; appends validate and freeze each entry. A checkpoint records the log's generation and length, and its entries reach storage with that commit (quint/checkpoint/logCheckpoint.qnt, recoveryEquivalent).
export function durableLogAtom<Entry, Meta, Event>(options: {
  readonly name: string
  readonly cacheChunks?: number
  readonly chunkItems?: number
  readonly entry: Schema.Schema<Entry>
  readonly meta: { readonly schema: Schema.Schema<Meta>; readonly initial: NoInfer<Meta> }
  readonly input: Schema.Schema<Event>
  readonly reduce: (state: { readonly log: Log<NoInfer<Entry>>; readonly meta: NoInfer<Meta> }, event: NoInfer<Event>, metadata: RecordMetadata, position: number) => { readonly log: Log<NoInfer<Entry>>; readonly meta: NoInfer<Meta> }
}): DurableAtom<{ readonly log: Log<Entry>; readonly meta: Meta }, Event> {
  type State = { readonly log: Log<Entry>; readonly meta: Meta }
  if (!options.name.trim()) throw new Error("Durable atom name must not be empty")
  const validateEntry = Schema.decodeUnknownSync(Schema.toType(options.entry), { onExcessProperty: "error" })
  const decodeMeta = Schema.decodeUnknownSync(Schema.toType(options.meta.schema), { onExcessProperty: "error" })
  // validateMeta proves only the parts of a header that changed, as durableAtom does for its state.
  const metaValidator = incrementalValidator(options.meta.schema, () => console.warn(`Log atom "${options.name}" header is not plain data; validation is O(header)`))
  const validatedMeta = new WeakSet<object>()
  const validateMeta = (meta: unknown) => {
    if (meta !== null && typeof meta === "object" && validatedMeta.has(meta)) return
    if (metaValidator.parse(meta) === invalid) decodeMeta(meta)
    if (meta !== null && typeof meta === "object") validatedMeta.add(meta)
  }
  const initial = structuredClone(options.meta.initial)
  validateMeta(initial)
  deepFreeze(initial)
  const accept = (value: Entry): Entry => { validateEntry(value); return deepFreeze(value) }
  const chunkItems = options.chunkItems ?? LOG_CHUNK
  if (!Number.isSafeInteger(chunkItems) || chunkItems < 1) throw new Error("Log chunkItems must be a positive safe integer")
  const cacheChunks = options.cacheChunks ?? DEFAULT_LOG_CACHE_CHUNKS
  if (!Number.isSafeInteger(cacheChunks) || cacheChunks < 1) throw new Error("Log cacheChunks must be a positive safe integer")
  const Stored = Schema.Struct({ generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), length: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))), entries: Schema.optionalKey(Schema.Array(Schema.Unknown)), meta: Schema.Unknown })
  const states = new WeakSet<object>()
  const logs = new WeakSet<object>()
  // registered records each new log version; storedLength applies only to the restored generation, since restart begins a generation with no stored rows.
  const registered = (service: typeof EventLog.Service, stored?: { readonly name: string; readonly length: number }) => (log: Log<Entry>, parent?: Log<Entry>) => {
    logs.add(log)
    const registry = service.logs
    if (registry?.storage) persistent.add(log)
    registry?.register(log, stored?.name === log.name ? stored.length : 0, parent)
  }
  const state = (log: Log<Entry>, meta: Meta): State => { const value = Object.freeze({ log, meta: deepFreeze(meta) }); states.add(value); return value }
  const empty = (service: typeof EventLog.Service) => makeLog<Entry>(options.name, 0, chunkItems, undefined, [], [], accept, registered(service))
  // normalize accepts the stored form or plain initial state, whose entries field is the log and whose other fields are the header.
  const normalize = (value: unknown) => {
    if (value !== null && typeof value === "object" && !("generation" in value)) {
      const { entries = [], ...meta } = value as { readonly entries?: readonly unknown[] }
      return { generation: 0, entries, meta }
    }
    return Schema.decodeUnknownSync(Stored)(value)
  }
  const restore = (value: unknown, service: typeof EventLog.Service): State => {
    const stored = normalize(value)
    validateMeta(stored.meta)
    if (stored.entries) return state(makeLog<Entry>(options.name, stored.generation, chunkItems, undefined, [], [], accept, registered(service)).append(stored.entries as Entry[]), stored.meta as Meta)
    const storage = service.logs?.storage
    if (!storage) throw new Error(`Log atom ${options.name} restores its entries from log storage`)
    const name = `${options.name}#${stored.generation}`
    return state(makeLog<Entry>(options.name, stored.generation, chunkItems, storedPrefix<Entry>(name, stored.length ?? 0, storage, cacheChunks, chunkItems), [], [], accept, registered(service, { name, length: stored.length ?? 0 })), stored.meta as Meta)
  }
  return durableProjection<State, Event>(options, {
    initial: service => state(empty(service), structuredClone(initial)),
    restore,
    check: (value, service) => {
      if (states.has(value)) return value
      if (!logs.has(value.log)) throw new Error("Reducer returned a foreign log")
      validateMeta(value.meta)
      ;service.logs?.register(value.log)
      return state(value.log, value.meta)
    },
    state: {
      name: options.name,
      decode: value => { const stored = normalize(value); validateMeta(stored.meta); for (const entry of stored.entries ?? []) validateEntry(entry); return stored },
      encode: value => {
        const { log, meta } = value as State
        const generation = Number(log.name.slice(log.name.lastIndexOf("#") + 1))
        return persistent.has(log) ? { generation, length: log.length, meta } : { generation, entries: log.slice(0, log.length), meta }
      },
    },
  })
}
