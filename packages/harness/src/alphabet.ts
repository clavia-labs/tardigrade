import type { Event } from "@flamecast/core"
import type { ProviderContinuation, RequestOptions, Usage } from "./infer"
import type { MessageOrigin } from "./module"

// The harness's own events, as constructors. `Event` is open because a reader must survive an
// event type it never met, and that openness is the right contract at every boundary. It is the
// wrong contract for the events this package writes itself: a misspelled field on an emission
// compiles, and the cost is silent. `keyOf` reads `callId` to derive a dedup key, so a
// `ToolReturned` carrying `calId` derives no key at all, the store stops absorbing its
// redeliveries, and the guarantee degrades with nothing to see.
//
// Each constructor returns a plain `Event`, so nothing downstream changes: the log, the folds, and
// the projections keep reading an open shape. The type is a gate on the way in, not a new
// representation.
//
// `at` is a parameter rather than a clock read, because a decide is a pure function of the log and
// the timestamp the runtime hands it.

export interface Stamped {
  readonly turn: string
  readonly at: number
}

export const messageReceived = (fields: {
  readonly id: string
  readonly text: string
  readonly at: number
  readonly agent?: string
  readonly output?: unknown
  readonly budget?: number
  readonly escalatable?: boolean
  readonly replyTo?: string
  readonly origin?: MessageOrigin
  readonly outcome?: "completed" | "failed"
  readonly usage?: Usage
}): Event => ({
  type: "MessageReceived",
  id: fields.id,
  text: fields.text,
  at: fields.at,
  ...(fields.agent === undefined ? {} : { agent: fields.agent }),
  ...(fields.output === undefined ? {} : { output: fields.output }),
  ...(fields.budget === undefined ? {} : { budget: fields.budget }),
  ...(fields.escalatable === undefined ? {} : { escalatable: fields.escalatable }),
  ...(fields.replyTo === undefined ? {} : { replyTo: fields.replyTo }),
  ...(fields.origin === undefined ? {} : { origin: fields.origin }),
  ...(fields.outcome === undefined ? {} : { outcome: fields.outcome }),
  ...(fields.usage === undefined ? {} : { usage: fields.usage })
})

export const modelCalled = (
  fields: Stamped & {
    readonly callId: string
    readonly reserved: Usage
    readonly options?: RequestOptions
  }
): Event => ({
  type: "ModelCalled",
  turn: fields.turn,
  callId: fields.callId,
  reserved: fields.reserved,
  ...(fields.options === undefined ? {} : { options: fields.options }),
  at: fields.at
})

export const modelDeferred = (
  fields: Stamped & {
    readonly callId: string
    readonly attempt: number
    readonly notBefore: number
    readonly reason: string
  }
): Event => ({
  type: "ModelDeferred",
  turn: fields.turn,
  callId: fields.callId,
  attempt: fields.attempt,
  notBefore: fields.notBefore,
  reason: fields.reason,
  at: fields.at
})

export const modelSettled = (
  fields: Stamped & {
    readonly callId: string
    readonly usage: Usage
    readonly reason: string
  }
): Event => ({
  type: "ModelSettled",
  turn: fields.turn,
  callId: fields.callId,
  usage: fields.usage,
  reason: fields.reason,
  at: fields.at
})

// The wake one wait is owed. It names the attempt it answers, so a wake that arrives twice, or one
// left over from a wait that has already been served, is refused rather than retried early.
export const alarmFired = (
  fields: Stamped & {
    readonly callId: string
    readonly attempt: number
  }
): Event => ({
  type: "AlarmFired",
  turn: fields.turn,
  callId: fields.callId,
  attempt: fields.attempt,
  at: fields.at
})

export const modelReturned = (
  fields: Stamped & {
    readonly callId: string
    readonly usage: Usage
    readonly continuation?: ProviderContinuation
  }
): Event => ({
  type: "ModelReturned",
  turn: fields.turn,
  callId: fields.callId,
  usage: fields.usage,
  ...(fields.continuation === undefined ? {} : { continuation: fields.continuation }),
  at: fields.at
})

export const textReturned = (fields: Stamped & { readonly text: string }): Event => ({
  type: "TextReturned",
  turn: fields.turn,
  text: fields.text,
  at: fields.at
})

export const toolCalled = (
  fields: Stamped & {
    readonly callId: string
    readonly name: string
    readonly arguments: unknown
  }
): Event => ({
  type: "ToolCalled",
  turn: fields.turn,
  callId: fields.callId,
  name: fields.name,
  arguments: fields.arguments,
  at: fields.at
})

// The dedup key of a tool result is `tr:<turn>/<callId>`, so both fields are required here. A
// result that carried neither would land twice on a redelivery and the machine would dispatch
// twice.
export const toolReturned = (
  fields: Stamped & {
    readonly callId: string
    readonly name: string
    readonly result: unknown
    readonly error?: string
  }
): Event => ({
  type: "ToolReturned",
  turn: fields.turn,
  callId: fields.callId,
  name: fields.name,
  result: fields.result,
  ...(fields.error === undefined ? {} : { error: fields.error }),
  at: fields.at
})

export const turnCompleted = (fields: Stamped & { readonly output: string }): Event => ({
  type: "TurnCompleted",
  turn: fields.turn,
  output: fields.output,
  at: fields.at
})

export const turnFailed = (fields: Stamped & { readonly error: string }): Event => ({
  type: "TurnFailed",
  turn: fields.turn,
  error: fields.error,
  at: fields.at
})

export const replyDelivered = (fields: Stamped & { readonly to?: string }): Event => ({
  type: "ReplyDelivered",
  turn: fields.turn,
  ...(fields.to === undefined ? {} : { to: fields.to }),
  at: fields.at
})

export const answerRejected = (
  fields: Stamped & { readonly callId: string; readonly error: string }
): Event => ({
  type: "AnswerRejected",
  turn: fields.turn,
  callId: fields.callId,
  error: fields.error,
  at: fields.at
})

export const budgetExhausted = (
  fields: Stamped & { readonly budget: number; readonly used: number }
): Event => ({
  type: "BudgetExhausted",
  turn: fields.turn,
  budget: fields.budget,
  used: fields.used,
  at: fields.at
})

export const budgetRequested = (
  fields: Stamped & {
    readonly callId: string
    readonly reason: string
    readonly amount: number
  }
): Event => ({
  type: "BudgetRequested",
  turn: fields.turn,
  callId: fields.callId,
  reason: fields.reason,
  amount: fields.amount,
  at: fields.at
})

export const budgetGranted = (
  fields: Stamped & { readonly callId: string; readonly amount: number }
): Event => ({
  type: "BudgetGranted",
  turn: fields.turn,
  callId: fields.callId,
  amount: fields.amount,
  at: fields.at
})

export const budgetDenied = (
  fields: Stamped & { readonly callId: string; readonly reason?: string }
): Event => ({
  type: "BudgetDenied",
  turn: fields.turn,
  callId: fields.callId,
  ...(fields.reason === undefined ? {} : { reason: fields.reason }),
  at: fields.at
})

export const compactionFired = (fields: {
  readonly at: number
  readonly turn?: string
}): Event => ({
  type: "CompactionFired",
  at: fields.at,
  ...(fields.turn === undefined ? {} : { turn: fields.turn })
})

export const compactionCompleted = (fields: {
  readonly upTo: number
  readonly summary: string
  readonly provider: string
  readonly at: number
  readonly turn?: string
}): Event => ({
  type: "CompactionCompleted",
  upTo: fields.upTo,
  summary: fields.summary,
  provider: fields.provider,
  at: fields.at,
  ...(fields.turn === undefined ? {} : { turn: fields.turn })
})

// What the model said before the provider stopped it at its output ceiling. `tool` and `arguments`
// are present when a tool call was the thing cut, and the arguments are the raw partial, which does
// not parse. They are recorded rather than described so a nudge can read which tool was cut.
export const answerTruncated = (
  fields: Stamped & {
    readonly callId: string
    readonly text: string
    readonly tokens: number
    readonly tool?: string
    readonly arguments?: string
  }
): Event => ({
  type: "AnswerTruncated",
  turn: fields.turn,
  callId: fields.callId,
  text: fields.text,
  tokens: fields.tokens,
  ...(fields.tool === undefined ? {} : { tool: fields.tool }),
  ...(fields.arguments === undefined ? {} : { arguments: fields.arguments }),
  at: fields.at
})
