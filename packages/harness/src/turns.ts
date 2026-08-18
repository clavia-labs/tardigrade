import type { Event } from "@flamecast/core"
import { spendOf, sumUsage, usageOf, type Spend, type Usage } from "./infer"

// Turn attribution. A turn is headed by one `MessageReceived`, and every event emitted while
// serving it carries `turn: <head id>`. Attribution is a fact in the log, never a derivation from
// position, so concurrent ingress can not cross-wire turns: a message committed mid-turn waits,
// unserved, until the fold reaches it.
//
// The views here are what the agent machines fold over. An empty view folds to the machine's
// initial state, and that is quiescence.

const idOf = (event: Event): string => String(event.id ?? "")

const stampOf = (event: Event): string | undefined =>
  event.turn === undefined ? undefined : String(event.turn)

const stamped = (log: ReadonlyArray<Event>, id: string): ReadonlyArray<Event> =>
  log.filter((event) => stampOf(event) === id)

const hasStamped = (log: ReadonlyArray<Event>, id: string, types: ReadonlyArray<string>): boolean =>
  log.some((event) => types.includes(event.type) && stampOf(event) === id)

const heads = (log: ReadonlyArray<Event>): ReadonlyArray<Event> =>
  log.filter((event) => event.type === "MessageReceived")

const TERMINALS = ["TurnCompleted", "TurnFailed"]

// The current turn's head: the earliest message with no stamped terminal.
export const turnHead = (log: ReadonlyArray<Event>): Event | undefined =>
  heads(log).find((head) => !hasStamped(log, idOf(head), TERMINALS))

// The current turn's id, or the empty string when no turn is open. A decide reads the whole log and
// stamps what it emits with this, so every event names the turn it served.
export const turnOf = (log: ReadonlyArray<Event>): string => {
  const head = turnHead(log)
  return head === undefined ? "" : idOf(head)
}

// The current turn's slice: its head plus its stamped events, in log order. This is the view a
// turn-scoped machine folds, so a queued next message can not open a second turn early.
export const turnView = (log: ReadonlyArray<Event>): ReadonlyArray<Event> => {
  const head = turnHead(log)
  return head === undefined ? [] : [head, ...stamped(log, idOf(head))]
}

export interface PendingDeferral {
  readonly turn: string
  readonly callId: string
  readonly attempt: number
  readonly notBefore: number
  readonly reason: string
}

// The open model wait on the current turn: a `ModelDeferred` that no wake and no later attempt has
// answered. The agent loop arms an alarm for it, or appends the wake when the due time has already
// passed, so a restart continues from the log rather than from a timer that died with the process.
export const pendingDeferral = (log: ReadonlyArray<Event>): PendingDeferral | undefined => {
  const view = turnView(log)
  for (let index = view.length - 1; index >= 0; index--) {
    const event = view[index]
    if (event === undefined) continue
    if (event.type === "ModelDeferred") {
      return {
        turn: String(event.turn ?? ""),
        callId: String(event.callId ?? ""),
        attempt: Number(event.attempt ?? 0),
        notBefore: Number(event.notBefore ?? 0),
        reason: String(event.reason ?? "")
      }
    }
    if (
      event.type === "AlarmFired" ||
      event.type === "ModelReturned" ||
      event.type === "ModelCalled" ||
      event.type === "ToolCalled" ||
      event.type === "TurnCompleted" ||
      event.type === "TurnFailed"
    ) {
      return undefined
    }
  }
  return undefined
}

// The turn owed a reply: terminal stamped, reply not. It lags one stage behind `turnView` on
// purpose, so a queued next turn never steals a finished turn's reply.
export const replyView = (log: ReadonlyArray<Event>): ReadonlyArray<Event> => {
  const head = heads(log).find(
    (candidate) =>
      hasStamped(log, idOf(candidate), TERMINALS) && !hasStamped(log, idOf(candidate), ["ReplyDelivered"])
  )
  return head === undefined ? [] : [head, ...stamped(log, idOf(head))]
}

// The model's projection of the log: turns in service order, each head just before its first
// stamped event, queued unserved messages excluded, unstamped events (compaction checkpoints,
// fires) passing through in place. This is the conversation as it was served, never as it happened
// to interleave at ingress.
export const servedLog = (log: ReadonlyArray<Event>): ReadonlyArray<Event> => {
  const current = turnHead(log)
  const emitted = new Set<string>()
  const byId = new Map(heads(log).map((head) => [idOf(head), head]))
  const out: Array<Event> = []
  for (const event of log) {
    if (event.type === "MessageReceived") continue
    const stamp = stampOf(event)
    if (stamp !== undefined && !emitted.has(stamp)) {
      const head = byId.get(stamp)
      if (head !== undefined) out.push(head)
      emitted.add(stamp)
    }
    out.push(event)
  }
  if (current !== undefined && !emitted.has(idOf(current))) out.push(current)
  return out
}

// What one turn spent on the model. Settled figures come from `ModelReturned`. Unsettled figures
// come from a `ModelCalled` still in flight and from a `ModelSettled` that closed an attempt that
// never returned a result, using the reservation `ModelCalled` carried.
export const usageIn = (log: ReadonlyArray<Event>, turn: string): Spend => {
  const settled: Array<Usage> = []
  const unsettled: Array<Usage> = []
  let open: Usage | undefined
  for (const event of log) {
    if (stampOf(event) !== turn) continue
    if (event.type === "ModelCalled") {
      if (open !== undefined) unsettled.push(open)
      open = usageOf(event.reserved)
      continue
    }
    if (event.type === "ModelReturned") {
      settled.push(usageOf(event.usage))
      open = undefined
      continue
    }
    if (event.type === "ModelSettled") {
      unsettled.push(usageOf(event.usage))
      open = undefined
    }
  }
  if (open !== undefined) unsettled.push(open)
  return spendOf(sumUsage(settled), sumUsage(unsettled))
}

// A tool result that reports what it spent. A sub-agent reports its own tree usage, and so does a
// tool that reached a model by another route, such as a script that delegated inside a sandbox.
// Reporting usage is the whole contract: a tool that reports it is counted, and one that does not
// spend has nothing to report.
const reportedUsage = (event: Event): Usage | undefined => {
  if (event.type !== "ToolReturned") return undefined
  const result = event.result as { readonly usage?: unknown } | undefined
  if (result === null || typeof result !== "object" || result.usage === undefined) return undefined
  return usageOf(result.usage)
}

// What one turn spent including everything it reached. The sum is inclusive over the whole
// delegation tree without reading another session's log.
export const treeUsageIn = (log: ReadonlyArray<Event>, turn: string): Spend => {
  const local = usageIn(log, turn)
  const nested = log
    .filter((event) => stampOf(event) === turn)
    .map(reportedUsage)
    .filter((usage): usage is Usage => usage !== undefined)
  return spendOf(sumUsage([local.settled, ...nested]), local.unsettled)
}

const quoted = (value: unknown): string => `"${String(value ?? "")}"`

const usageLine = (value: unknown): string => {
  const usage = usageOf(value)
  const cost = usage.costUsd === undefined ? "unknown" : `$${usage.costUsd.toFixed(4)}`
  return `${usage.promptTokens} in / ${usage.completionTokens} out / ${cost}`
}

// The columns the readable rendering lines up on: the ordinal, the event type, the turn (or the
// message id on a head), then the call id where the event names one.
//
// These are minimum widths rather than fixed ones. They are the widths the documented sample
// output lines up on, so a log of short ids renders exactly as documented, and a column grows when
// a value would otherwise run into the next one. The framework mints its own call ids as
// `${turn}/infer/${n}`, which is eleven characters and never fit the documented seven: a fixed
// column rendered `m-1/infer/0108 in / 32 out`, which reads as a call id of `m-1/infer/0108`.
const TYPE_WIDTH = 18
const WHO_WIDTH = 6
const CALL_WIDTH = 7

// The width a column needs: the widest value in it, plus the separating space, never less than the
// documented minimum. The whole log is in hand, so the transcript stays aligned end to end rather
// than shifting when a longer id arrives.
const widthOf = (values: ReadonlyArray<string>, minimum: number): number =>
  Math.max(minimum, ...values.map((value) => (value === "" ? 0 : value.length + 3)))

const detailOf = (event: Event, callWidth: number): string => {
  const call = (rest: string) => `${String(event.callId ?? "").padEnd(callWidth)}${rest}`
  switch (event.type) {
    case "MessageReceived":
      return `${quoted(event.text)}   agent=${String(event.agent ?? "")}`
    case "ModelCalled":
      return call(event.reserved === undefined ? "" : `reserved ${usageLine(event.reserved)}`)
    case "ModelDeferred":
      return call(
        `attempt=${String(event.attempt ?? "")} notBefore=${String(event.notBefore ?? "")} ${quoted(event.reason)}`
      )
    case "AlarmFired":
      return call("")
    case "ModelSettled":
      return call(`${usageLine(event.usage)} ${quoted(event.reason)}`)
    case "ModelReturned":
      return call(usageLine(event.usage))
    case "TextReturned":
      return quoted(event.text)
    case "ToolCalled":
      return call(`${String(event.name ?? "")} ${JSON.stringify(event.arguments ?? {})}`)
    case "ToolReturned":
      return call(
        event.error === undefined
          ? JSON.stringify(event.result ?? null)
          : `error: ${String(event.error)}`
      )
    case "TurnCompleted":
      return quoted(event.output)
    case "TurnFailed":
      return quoted(event.error)
    case "AnswerTruncated":
      return call(
        `${quoted(event.text)} tokens=${String(event.tokens ?? "")}${
          event.tool === undefined ? "" : ` cut=${String(event.tool)}`
        }`
      )
    case "ReplyDelivered":
      return event.to === undefined ? "" : `to=${String(event.to)}`
    case "BudgetExhausted":
      return `budget=${String(event.budget ?? "")} used=${String(event.used ?? "")}`
    case "BudgetRequested":
      return call(`amount=${String(event.amount ?? "")} ${quoted(event.reason)}`)
    case "BudgetGranted":
      return `amount=${String(event.amount ?? "")}`
    case "BudgetDenied":
      return event.reason === undefined ? "" : quoted(event.reason)
    case "AnswerRejected":
      return call(quoted(event.error))
    case "CompactionCompleted":
      return `upTo=${String(event.upTo ?? "")} provider=${String(event.provider ?? "")} ${quoted(event.summary)}`
    case "CompactionFired":
      return ""
    default: {
      // A tolerant read at the transcript too: an event type this build never met still prints its
      // facts rather than an empty line.
      const { type: _type, turn: _turn, at: _at, ...rest } = event
      return Object.keys(rest).length === 0 ? "" : JSON.stringify(rest)
    }
  }
}

// Who the line belongs to: the message id on a head, the turn stamp on everything else.
const whoOf = (event: Event): string =>
  event.type === "MessageReceived" ? idOf(event) : (stampOf(event) ?? "")

// The log as text, one line per event. It is the readable form of the record, and it is also
// what a model-written compaction summarizes.
export const transcript = (log: ReadonlyArray<Event>): string => {
  const typeWidth = widthOf(log.map((event) => event.type), TYPE_WIDTH)
  const whoWidth = widthOf(log.map(whoOf), WHO_WIDTH)
  const callWidth = widthOf(log.map((event) => String(event.callId ?? "")), CALL_WIDTH)
  return log
    .map((event, index) => {
      const line = `${String(index + 1).padStart(2)}  ${event.type.padEnd(typeWidth)}${whoOf(event).padEnd(whoWidth)}${detailOf(event, callWidth)}`
      return line.trimEnd()
    })
    .join("\n")
}
