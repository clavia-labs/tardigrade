import { styleText, stripVTControlCharacters } from "node:util"
import { Console, Effect, Schema } from "effect"
import { RuntimeError, type Recorded } from "@clavia/tardigrade-experimental-core"
import type { ThreadCoordinate } from "@clavia/tardigrade-experimental-host"
import { observeBunThread } from "@clavia/tardigrade-experimental-platform/bun"
const Event = Schema.Record(Schema.String, Schema.Unknown)
type Event = typeof Event.Type

export const DEFAULT_POLL_MS = 250
export const DEFAULT_BATCH_SIZE = 100
export const DEFAULT_WATCH_WIDTH = 120

const line = (value: unknown) => value == null ? "" : Array.from(stripVTControlCharacters(String(value)), character => {
  const code = character.codePointAt(0)!
  return code < 32 || (code >= 127 && code <= 159) ? " " : character
}).join("").replace(/\s+/g, " ").trim()


function formatEntry(record: Recorded<Event>, seq: number, width = DEFAULT_WATCH_WIDTH, color = false): string {
  if (!Number.isSafeInteger(width) || width < 1) throw new RuntimeError("Event log width must be a positive integer")
  const { event, recordedAt } = record
  const { type, ...payload } = event
  const text = `${String(seq).padStart(6, "0")}  ${String(type).padEnd(22)}  ${recordedAt ?? "unknown"}  ${line(JSON.stringify(payload))}`.trimEnd()
  let row = text
  if (Bun.stringWidth(text) > width) {
    row = ""
    let used = 0
    for (const { segment } of new Intl.Segmenter().segment(text)) {
      const size = Bun.stringWidth(segment)
      if (used + size > width - 1) break
      row += segment
      used += size
    }
    row += "…"
  }
  if (!color) return row
  return styleText("dim", row)
}


export const watchLog = (options: {
  readonly storage: string
  readonly coordinate?: ThreadCoordinate | undefined
  readonly resolveThread: Effect.Effect<ThreadCoordinate | undefined, Error>
  readonly after: number
  readonly poll: number
  readonly batchSize: number
  readonly once: boolean
  readonly json: boolean
  readonly width?: number | undefined
}) => Effect.scoped(Effect.gen(function* () {
  if (!Number.isSafeInteger(options.poll) || options.poll < 1) return yield* Effect.fail(new RuntimeError("--poll must be a positive integer"))
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1) return yield* Effect.fail(new RuntimeError("--batch-size must be a positive integer"))
  if (!Number.isSafeInteger(options.after) || options.after < -1) return yield* Effect.fail(new RuntimeError("--after must be an integer of at least -1"))
  if (options.width !== undefined && (!Number.isSafeInteger(options.width) || options.width < 1)) return yield* Effect.fail(new RuntimeError("--width must be a positive integer"))
  if (!options.json) yield* Console.log("All events; … marks clipped text. Use --json for full events.")
  let store: ReturnType<typeof observeBunThread<Event>> | undefined
  let identity: string | undefined
  yield* Effect.addFinalizer(() => Effect.suspend(() => store?.close ?? Effect.void))
  let after = options.after
  while (true) {
    const coordinate = options.coordinate ?? (yield* options.resolveThread.pipe(Effect.mapError(RuntimeError.from)))
    if (!coordinate) {
      if (options.once) return yield* Effect.fail(new RuntimeError("No active thread. Start chat or choose --thread."))
      yield* Effect.sleep(options.poll)
      continue
    }
    const key = JSON.stringify(coordinate)
    if (key !== identity) {
      yield* Effect.suspend(() => store?.close ?? Effect.void)
      store = observeBunThread({ storage: options.storage, coordinate, schema: Event })
      identity = key
      after = options.after
      if (!options.json) yield* Console.log(`Thread: ${coordinate.thread}`)
    }
    const current = store!
    yield* current.refresh.pipe(Effect.mapError(RuntimeError.from))
    const entries = yield* Effect.try({ try: () => current.records.get().slice(after + 1, after + 1 + options.batchSize), catch: RuntimeError.from })
    for (const record of entries) {
      const seq = after + 1
      const width = options.width ?? (process.stdout.columns ? process.stdout.columns - 1 : DEFAULT_WATCH_WIDTH)
      yield* Console.log(options.json ? JSON.stringify({ seq, ...record }) : formatEntry(record, seq, Math.max(1, width), !!process.stdout.isTTY))
      after = seq
    }
    if (entries.length === options.batchSize) continue
    if (options.once) return
    yield* Effect.sleep(options.poll)
  }
}))
