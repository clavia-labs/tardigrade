import type { Event, EventRow } from "@clavia/tardigrade-client"
import { DEFAULT_JSON_PARSE_DEPTH, FIELD_INLINE_CHARS, SUMMARY_CHARS } from "./policy"

// The event list's projections: what a row says, what color its stamp carries, how long the thing
// it names took, and which events are ends rather than rows. Every function here is pure, so the
// screen is these answers rendered and the tests are arrays of events.

// Stamp is the chip that carries an event type verbatim. The type is a machine value, so it is set
// in mono and never translated: a reader who has seen the log sees the same word here.
export interface Stamp {
  readonly fg: string
  readonly bg: string
}

const NEUTRAL: Stamp = { fg: "var(--neutral)", bg: "var(--neutral-wash)" }
const DISPATCH: Stamp = { fg: "var(--run)", bg: "var(--run-wash)" }
const AWAIT: Stamp = { fg: "var(--wait)", bg: "var(--wait-wash)" }
const DONE: Stamp = { fg: "var(--ok)", bg: "var(--ok-wash)" }
const BROKEN: Stamp = { fg: "var(--fail)", bg: "var(--fail-wash)" }

// The stamp palette. Color is spent on the data's voice alone, so a type reads as one of four
// voices rather than as its own hue: prose is neutral, dispatched work is the run's amber, waiting
// on another party is the indigo, a terminal that landed is the green, and a terminal that died is
// the rust (mock.html, the event rows; voyager-design-system.md, principle 1).
const STAMPS: Readonly<Record<string, Stamp>> = {
  MessageReceived: NEUTRAL,
  ModelCalled: NEUTRAL,
  TextReturned: NEUTRAL,
  CompactionCompleted: NEUTRAL,
  ReplyDelivered: NEUTRAL,
  CodeDispatched: DISPATCH,
  ToolCalled: DISPATCH,
  TurnResumed: DISPATCH,
  PackageCalled: AWAIT,
  BlockedOn: AWAIT,
  BudgetRequested: AWAIT,
  BudgetGranted: AWAIT,
  BudgetDenied: AWAIT,
  BudgetExhausted: AWAIT,
  ToolReturned: DONE,
  TurnCompleted: DONE,
  OutputRejected: BROKEN,
  TurnFailed: BROKEN
}

// stampOf is a row's chip color. A type the app has never heard of is neutral: an unknown event
// still renders, because the log's alphabet is open and a reader must see what landed
// (packages/core/src/event.ts).
export const stampOf = (type: string): Stamp => STAMPS[type] ?? NEUTRAL

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined)

// truncate flattens a value onto one line and cuts it to `chars`. Newlines are collapsed rather
// than escaped: a row is one line high, and a code body must not be able to change that.
export const truncate = (text: string, chars: number): string => {
  const flat = text.replace(/\s+/gu, " ").trim()
  return flat.length <= chars ? flat : `${flat.slice(0, Math.max(0, chars - 1))}…`
}

const parsedJson = (value: string): unknown => {
  const text = value.trim()
  if (!((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]")))) return value
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null ? parsed : value
  } catch {
    return value
  }
}

// structuredValue decodes JSON-shaped strings while preserving the object fields that contain
// them. depth bounds strings nested inside strings and is a caller-visible display policy.
export const structuredValue = (value: unknown, depth: number = DEFAULT_JSON_PARSE_DEPTH): unknown => {
  if (typeof value === "string") {
    if (depth <= 0) return value
    const parsed = parsedJson(value)
    return parsed === value ? value : structuredValue(parsed, depth - 1)
  }
  if (Array.isArray(value)) return value.map((item) => structuredValue(item, depth))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, structuredValue(item, depth)]))
  }
  return value
}

// preview renders any payload as one line: a string as itself, anything else as its JSON.
const preview = (value: unknown, chars: number, jsonDepth: number): string => {
  if (value === undefined) return ""
  const shown = structuredValue(value, jsonDepth)
  const text = typeof shown === "string" ? shown : JSON.stringify(shown)
  return text === undefined ? String(value) : truncate(text, chars)
}

// A code body previews as its source rather than as the JSON object carrying it, because the source
// is what the reader recognizes (`execute · const kids = await Promise.all(…)`).
const argumentsPreview = (value: unknown, chars: number): string => {
  if (typeof value === "object" && value !== null && "code" in value) {
    const code = (value as { readonly code: unknown }).code
    if (typeof code === "string") return truncate(code, chars)
  }
  return preview(value, chars, DEFAULT_JSON_PARSE_DEPTH)
}

const line = (parts: ReadonlyArray<string | undefined>, chars: number): string =>
  truncate(parts.filter((part) => part !== undefined && part !== "").join(" · "), chars)

// summaryOf is the one line a row shows for an event: what a reader needs to decide whether to open
// it. The known alphabet is the agent lane's and the code lane's (packages/agent/src/events.ts,
// packages/code/src/events.ts); a type from neither renders its field names, so an event the app has
// never seen still says what it carries rather than nothing.
export const summaryOf = (
  event: Event,
  chars: number = SUMMARY_CHARS,
  jsonDepth: number = DEFAULT_JSON_PARSE_DEPTH
): string => {
  switch (event.type) {
    case "MessageReceived": {
      // A reply is an inbound message answering an id this thread sent out, and it reads as the
      // answer it is (packages/core/src/message.ts, replyEvent).
      const outcome = str(event.outcome)
      const from = str(event.from)
      if (outcome !== undefined) {
        return line(["reply", `outcome: ${outcome}`, from === undefined ? undefined : `from ${from}`], chars)
      }
      return line([str(event.text) ?? ""], chars)
    }
    case "ModelCalled":
      return line([`attempt ${(num(event.ordinal) ?? 0) + 1}`, str(event.turn)], chars)
    case "TextReturned":
      return line([str(event.text) ?? ""], chars)
    case "ToolCalled":
      return line([str(event.name), argumentsPreview(event.arguments, chars)], chars)
    case "ToolReturned":
      return line([str(event.callId), preview(event.result, chars, jsonDepth)], chars)
    case "CodeDispatched": {
      const code = str(event.code) ?? ""
      const lines = code.length === 0 ? 0 : code.split("\n").length
      return line([str(event.execId), `${lines} ${lines === 1 ? "line" : "lines"}`], chars)
    }
    case "PackageCalled":
      return line([str(event.name), preview(event.arguments, chars, jsonDepth)], chars)
    case "BlockedOn":
      return line([`awaiting ${str(event.awaiting) ?? ""}`], chars)
    case "OutputRejected": {
      const errors = Array.isArray(event.errors) ? (event.errors as ReadonlyArray<unknown>) : []
      return line([str(event.contract) ?? "", `${errors.length} ${errors.length === 1 ? "reason" : "reasons"}`, str(errors[0])], chars)
    }
    case "TurnCompleted":
      return line([preview(event.output, chars, jsonDepth)], chars)
    case "TurnFailed":
      return line([str(event.cause) ?? "failed", str(event.error)], chars)
    case "TurnResumed":
      return line([str(event.turn), `epoch ${String(num(event.failedEpoch))} to ${String(num(event.epoch))}`], chars)
    case "ReplyDelivered": {
      const to = str(event.to)
      return line([to === undefined ? "no replyTo" : `to ${to}`], chars)
    }
    case "BudgetExhausted":
      return line([`used ${String(num(event.used))} of ${String(num(event.budget))}`], chars)
    case "BudgetRequested":
      return line([`asks ${String(num(event.amount))}`, str(event.reason)], chars)
    case "BudgetGranted":
      return line([`granted ${String(num(event.amount))}`], chars)
    case "BudgetDenied":
      return line([str(event.reason) ?? "denied"], chars)
    case "CompactionCompleted":
      return line([`keep from ${str(event.keepFrom) ?? ""}`, preview(event.summary, chars, jsonDepth)], chars)
    default:
      return line([Object.keys(event).filter((field) => field !== "type").join(", ")], chars)
  }
}

const pad = (value: number, width: number): string => String(value).padStart(width, "0")

// clockOf is the wall clock of an event, in the reader's own zone. The log stores epoch
// milliseconds and a reader compares rows against the clock on their wall, so the row shows hours
// and minutes and the expansion shows the second and the millisecond too (instantOf).
export const clockOf = (at: number): string => {
  const when = new Date(at)
  return `${pad(when.getHours(), 2)}:${pad(when.getMinutes(), 2)}`
}

// instantOf is the same wall clock to the millisecond, which is the resolution the log orders by.
// An expanded field states the instant rather than the epoch number, because no reader reads an
// epoch and the ordering of two events a few milliseconds apart is what the field is opened for.
export const instantOf = (at: number): string => {
  const when = new Date(at)
  return `${clockOf(at)}:${pad(when.getSeconds(), 2)}.${pad(when.getMilliseconds(), 3)}`
}

// Field is one line of an opened row: the event's own field name and the value rendered for
// reading. `kind` is "code" for a source body, which is the one payload that reads as a block and
// the one that sits in a well (src/tun.css, .event-code).
export interface Field {
  readonly key: string
  readonly value: string
  readonly kind: "text" | "code" | "json"
}

// STAMP is what the host writes onto every event it records, whatever lane minted it: the turn the
// event belongs to, the trace it belongs to, and the instant. It closes each order, between the
// event's own ids and the payload they name.
const STAMP: ReadonlyArray<string> = ["turn", "traceparent", "at"]

// The field order per event type: what names the event, then when it happened, then what it
// carries. A reader opens a row to find an id to follow or a payload to read, and those are the two
// ends of the list. The orders name the lanes' own fields (packages/core/src/message.ts,
// packages/agent/src/events.ts, packages/code/src/events.ts). A field an order does not name still
// renders, after the named ones and in the event's own key order, so a type this table is behind on
// hides nothing; a type it lists not at all falls back to that order entirely.
const ORDER: Readonly<Record<string, ReadonlyArray<string>>> = {
  MessageReceived: ["id", "from", "replyTo", "outcome", "source", "chat", "sender", ...STAMP, "text", "input", "output", "data"],
  ModelCalled: ["callId", "ordinal", "epoch", "output", ...STAMP],
  TextReturned: [...STAMP, "text"],
  ToolCalled: ["callId", "name", ...STAMP, "arguments", "usage"],
  ToolReturned: ["callId", ...STAMP, "result"],
  CodeDispatched: ["execId", ...STAMP, "code"],
  CodeSettled: ["execId", ...STAMP, "result", "error", "logs"],
  PackageCalled: ["callId", "name", ...STAMP, "arguments"],
  PackageReturned: ["callId", ...STAMP, "result"],
  BlockedOn: ["callId", "awaiting", ...STAMP],
  OutputRejected: ["contract", "attempt", "epoch", ...STAMP, "errors", "text", "usage"],
  TurnCompleted: ["epoch", ...STAMP, "output", "usage"],
  TurnFailed: ["epoch", "cause", "attempts", "attemptKey", ...STAMP, "error", "usage", "policy"],
  TurnResumed: ["failedEpoch", "epoch", ...STAMP],
  ReplyDelivered: ["to", ...STAMP],
  BudgetExhausted: ["budget", "used", ...STAMP],
  BudgetRequested: ["callId", "amount", "reason", ...STAMP],
  BudgetGranted: ["callId", "amount", ...STAMP],
  BudgetDenied: ["callId", "reason", ...STAMP],
  CompactionCompleted: ["keepFrom", ...STAMP, "summary"]
}

// TIME_FIELDS are the fields whose number is an instant rather than a quantity. The lanes stamp
// every event with `at` and nothing else carries a clock.
export const TIME_FIELDS: ReadonlyArray<string> = ["at"]

// valueOf renders one field for the value cell. A string is itself, so a code body keeps its own
// line breaks and the cell wraps them. Anything else is its JSON, on one line while it fits within
// `inlineChars` and indented past that, because a long object is read by its shape.
const valueOf = (value: unknown, inlineChars: number, jsonDepth: number): { readonly text: string; readonly json: boolean } => {
  const shown = structuredValue(value, jsonDepth)
  if (typeof shown === "string") return { text: shown, json: false }
  if (shown === null || typeof shown !== "object") return { text: String(shown), json: false }
  const compact = JSON.stringify(shown)
  if (compact === undefined) return { text: String(shown), json: false }
  return { text: compact.length <= inlineChars ? compact : JSON.stringify(shown, null, 2), json: true }
}

// fieldsOf is what the inspector shows: every event field in the order its type states, rendered
// for reading. `type` is dropped because the inspector's stamp already says it. IDs, correlation
// keys, instants, and payloads remain because the inspector is the complete event view.
export const fieldsOf = (
  event: Event,
  inlineChars: number = FIELD_INLINE_CHARS,
  jsonDepth: number = DEFAULT_JSON_PARSE_DEPTH
): ReadonlyArray<Field> => {
  const own = Object.keys(event).filter((field) => field !== "type" && event[field] !== undefined)
  const order = ORDER[event.type] ?? []
  const keys = [...order.filter((field) => own.includes(field)), ...own.filter((field) => !order.includes(field))]
  const fields: Array<Field> = []
  for (const key of keys) {
    const raw = event[key]
    const rendered = TIME_FIELDS.includes(key) && typeof raw === "number"
      ? { text: instantOf(raw), json: false }
      : valueOf(raw, inlineChars, jsonDepth)
    const kind = event.type === "CodeDispatched" && key === "code" ? "code" : rendered.json ? "json" : "text"
    fields.push({ key, value: rendered.text, kind })
  }
  return fields
}

// merged folds new rows into the log the screen holds. The stream and the polling fallback both
// land here, and both can redeliver a seq the screen already has (a reconnect replays from the last
// id the browser saw), so the merge is by seq and the result stays in log order.
export const merged = (rows: ReadonlyArray<EventRow>, next: ReadonlyArray<EventRow>): ReadonlyArray<EventRow> => {
  if (next.length === 0) return rows
  const bySeq = new Map(rows.map((row) => [row.seq, row]))
  for (const row of next) bySeq.set(row.seq, row)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

// spanOf renders an elapsed time in one unit, the same ladder the ages use. Under a second reads in
// milliseconds, because a dispatch that returns instantly is a fact worth seeing.
export const spanOf = (ms: number): string => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

// The events that are the end of a pair and nothing else. They carry no summary a reader wants as
// its own row: `CodeSettled` says what the dispatch returned and `PackageReturned` what the call
// answered, so each is folded into the duration on the row that opened it. Every other type renders.
export const FOLDED: ReadonlyArray<string> = ["CodeSettled", "PackageReturned"]

// Moment is one rendered row: the log's own event, plus the three things the row states about it.
export interface Moment {
  readonly seq: number
  readonly event: Event
  readonly summary: string
  readonly time: string
  // The instant the row is placed at on the window's axis, in epoch milliseconds. Absent for an
  // event the host stamped no clock on, which the window then holds outside every bucket.
  readonly at: number | undefined
  // Absent when the pair has no end yet, which is the honest answer while the work is still
  // running: an open dispatch shows a time and no span.
  readonly duration: string | undefined
}

const at = (event: Event): number | undefined => num(event["at"])
const key = (event: Event, field: string): string | undefined => str(event[field])

// endsOf indexes every span's closing timestamp by the id that names the span: an execution by its
// `execId`, a package call by its `callId`, and a turn by the inbound message's `id`. A turn is
// indexed by its start rather than its end, which is why `spansOf` reads it in the other direction.
const endsOf = (rows: ReadonlyArray<EventRow>) => {
  const execs = new Map<string, number>()
  const calls = new Map<string, number>()
  const turns = new Map<string, number>()
  for (const { event } of rows) {
    const when = at(event)
    if (when === undefined) continue
    const id =
      event.type === "CodeSettled"
        ? key(event, "execId")
        : event.type === "PackageReturned"
          ? key(event, "callId")
          : event.type === "MessageReceived"
            ? key(event, "id")
            : undefined
    if (id === undefined) continue
    if (event.type === "CodeSettled") execs.set(id, when)
    else if (event.type === "PackageReturned") calls.set(id, when)
    else if (!turns.has(id)) turns.set(id, when)
  }
  return { execs, calls, turns }
}

// momentsOf is the whole list: the log in log order, with the pair-halves folded away and each
// remaining row carrying the span it opened. A `CodeDispatched` spans to its `CodeSettled`, a
// `PackageCalled` to its `PackageReturned`, and a `TurnCompleted` back to the `MessageReceived`
// that opened its turn (packages/code/src/events.ts, packages/agent/src/events.ts). The three ids
// are the lanes' own correlation keys, so nothing here parses an id or guesses a pairing, and a
// span whose other half is outside the rows the screen holds simply has no duration.
export const momentsOf = (rows: ReadonlyArray<EventRow>): ReadonlyArray<Moment> => {
  const { calls, execs, turns } = endsOf(rows)
  const spanOfRow = (event: Event): number | undefined => {
    const when = at(event)
    if (when === undefined) return undefined
    if (event.type === "CodeDispatched") {
      const end = execs.get(key(event, "execId") ?? "")
      return end === undefined ? undefined : end - when
    }
    if (event.type === "PackageCalled") {
      const end = calls.get(key(event, "callId") ?? "")
      return end === undefined ? undefined : end - when
    }
    if (event.type === "TurnCompleted") {
      const start = turns.get(key(event, "turn") ?? "")
      return start === undefined ? undefined : when - start
    }
    return undefined
  }
  return rows
    .filter(({ event }) => !FOLDED.includes(event.type))
    .map(({ event, seq }): Moment => {
      const when = at(event)
      const span = spanOfRow(event)
      return {
        seq,
        event,
        at: when,
        summary: summaryOf(event),
        time: when === undefined ? "" : clockOf(when),
        duration: span === undefined ? undefined : spanOf(span)
      }
    })
}
