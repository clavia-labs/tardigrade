import { isDeepStrictEqual } from "node:util"
import { Schema } from "effect"

const LogPath = Schema.Array(Schema.Union([Schema.String, Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))]))
// LogRange names entries [start, end) of one log generation, optionally projected through each; a range of a generation never changes (quint/checkpoint/logCheckpoint.qnt, rangesStable).
export const LogRange = Schema.Struct({ log: Schema.String, start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), end: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), each: Schema.optionalKey(LogPath) })
export type LogRange = typeof LogRange.Type

const LogSelectionType = Symbol("LogSelection")
export interface LogSelection<Value> { readonly [LogSelectionType]: Value }
const selections = new WeakMap<object, LogRange>()
// logSelection returns a token an act input can carry in place of the range's values.
export const logSelection = <Value = unknown>(range: LogRange): LogSelection<Value> => { const token = Object.freeze({}) as LogSelection<Value>; selections.set(token, Object.freeze(range)); return token }
export const logSelectionReference = (value: unknown): LogRange | undefined => typeof value === "object" && value !== null ? selections.get(value) : undefined

interface ReadableLog { readonly name: string; readonly length: number; readonly slice: (start: number, end: number) => readonly unknown[] }
// LogStorage reads stored entries [start, end) of a log generation synchronously, in index order.
export interface LogStorage { readonly load: (log: string, start: number, end: number) => readonly unknown[] }
// LogChanges lists entries a commit writes; rows are keyed by log generation and index, so rewriting an entry is idempotent.
export interface LogChanges { readonly entries: readonly { readonly log: string; readonly index: number; readonly value: unknown }[] }

// logRegistry keeps the longest version of each log generation a runtime has built, and the length already stored, so a commit writes only new entries and a range resolves from memory or storage.
export function logRegistry(storage?: LogStorage) {
  const latest = new Map<string, ReadableLog>()
  const stored = new Map<string, number>()
  const checked = new WeakSet<object>()
  const project = (value: unknown, path: readonly (string | number)[]) => path.reduce<unknown>((current, key) => {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) throw new Error("Invalid log selection path")
    return (current as Record<string | number, unknown>)[key]
  }, value)
  return {
    storage,
    // register rejects divergent prefixes; a checked parent or common stored prefix avoids rechecking unchanged entries (properties/durable-state.test.ts).
    register: (log: ReadableLog, storedLength = 0, parent?: ReadableLog) => {
      const current = latest.get(log.name)
      if (current && !checked.has(log)) {
        const start = parent?.name === log.name && checked.has(parent) ? parent.length : Math.min(storedLength, stored.get(log.name) ?? 0)
        const end = Math.min(current.length, log.length)
        if (start < end && !isDeepStrictEqual(current.slice(start, end), log.slice(start, end))) throw new Error(`Conflicting log generation: ${log.name}`)
      }
      checked.add(log)
      if (!current || current.length < log.length) latest.set(log.name, log)
      if (storedLength > (stored.get(log.name) ?? 0)) stored.set(log.name, storedLength)
    },
    read: (range: LogRange): readonly unknown[] => {
      const log = latest.get(range.log)
      const values = log && log.length >= range.end ? log.slice(range.start, range.end) : storage?.load(range.log, range.start, range.end)
      if (!values || values.length !== range.end - range.start) throw new Error(`Log range ${range.log} [${range.start}, ${range.end}) is unavailable`)
      return range.each ? values.map(value => project(value, range.each!)) : values
    },
    staged: (): LogChanges => ({ entries: [...latest].flatMap(([name, log]) => log.slice(stored.get(name) ?? 0, log.length).map((value, offset) => ({ log: name, index: (stored.get(name) ?? 0) + offset, value }))) }),
    committed: (changes: LogChanges) => { for (const entry of changes.entries) if (entry.index + 1 > (stored.get(entry.log) ?? 0)) stored.set(entry.log, entry.index + 1) },
  }
}
export type LogRegistry = ReturnType<typeof logRegistry>
