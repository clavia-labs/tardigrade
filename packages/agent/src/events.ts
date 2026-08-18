import { Schema } from "effect"
import { MessageReceived } from "@flamecast/core/message"
import type { Event } from "@flamecast/core/event"
import type { KeyFragment } from "@flamecast/core/event-log"

// The agent's domain events. This alphabet belongs to the agent, and core never learns it: core
// sees only the open envelope. The model responds by acting: its recorded decision is the
// consequence event it emits, and the prose it emits alongside is a `TextReturned`. The final
// answer lives on `TurnCompleted` alone.
//
// The union projects onto OpenEnv RFC 005's HarnessEvent stream: `ModelCalled` -> LLM_REQUEST,
// `TextReturned` -> LLM_RESPONSE, `ToolCalled` -> TOOL_CALL, `ToolReturned` -> TOOL_RESULT,
// `TurnCompleted` -> TURN_COMPLETE with TEXT_OUTPUT as payload, `TurnFailed` -> ERROR.
// `MessageReceived` is the step() input on their side of the wire.

// MessageReceived is the canonical inbound (core/message.ts), shared with every other actor
// kind.
export { MessageReceived } from "@flamecast/core/message"

// ToolCalled is the ask: the turn calls a tool. `callId` correlates the return to this call.
export const ToolCalled = Schema.Struct({
  type: Schema.Literal("ToolCalled"),
  callId: Schema.String,
  name: Schema.String,
  arguments: Schema.Unknown,
  at: Schema.Number
})

// ToolReturned is the answer: the world's reply to one call. A failed call is a returned error,
// and the model reads it. Only the turn's own death is a `TurnFailed`.
export const ToolReturned = Schema.Struct({
  type: Schema.Literal("ToolReturned"),
  callId: Schema.String,
  result: Schema.Unknown,
  at: Schema.Number
})

// ModelCalled is the ask to the model and the attempt mark in one, appended before the inference
// runs. A committed consequence after it is the answer. Consecutive `ModelCalled` with nothing
// between them are attempts that died, and the give-up guard reads that count.
export const ModelCalled = Schema.Struct({
  type: Schema.Literal("ModelCalled"),
  callId: Schema.String,
  // The occurrence: distinct per physical attempt, the dedup key's scope. callId stays the
  // provider idempotency key, shared across retries of one logical attempt.
  ordinal: Schema.optional(Schema.Number),
  turn: Schema.optional(Schema.String),
  at: Schema.Number
})

// TextReturned is the prose the model emitted alongside its decision: working commentary,
// journaled and never delivered. The final answer is `TurnCompleted.output`, never this.
export const TextReturned = Schema.Struct({
  type: Schema.Literal("TextReturned"),
  text: Schema.String,
  at: Schema.Number
})

// TurnCompleted is the success terminal, under every policy. The event carries the output.
export const TurnCompleted = Schema.Struct({
  type: Schema.Literal("TurnCompleted"),
  output: Schema.String,
  at: Schema.Number
})

// TurnFailed is the failure terminal: the turn died and recovery gave up.
export const TurnFailed = Schema.Struct({
  type: Schema.Literal("TurnFailed"),
  error: Schema.String,
  at: Schema.Number
})

// ReplyDelivered records that the turn's terminal went home, or had no home to go to. The
// committed record binds, so a re-settle never delivers a reply twice.
export const ReplyDelivered = Schema.Struct({
  type: Schema.Literal("ReplyDelivered"),
  to: Schema.optional(Schema.String), // absent = the inbound named no replyTo, and nothing was sent
  at: Schema.Number
})

// BudgetExhausted is the wall, fired once when the spend passes the brief's budget. The tools
// reactor reads it and refuses further execute, so the model answers with its best result.
export const BudgetExhausted = Schema.Struct({
  type: Schema.Literal("BudgetExhausted"),
  budget: Schema.Number,
  used: Schema.Number,
  turn: Schema.optional(Schema.String),
  at: Schema.Number
})

// BudgetRequested opens the escalation lifecycle. At its wall an escalatable agent may ask its
// parent for budget: request_budget records the ask and pauses the turn, agents.run hands the
// request to the parent, and the answer reopens the budget (grant) or closes it (denial). See
// docs/agent-budgets.md.
export const BudgetRequested = Schema.Struct({
  type: Schema.Literal("BudgetRequested"),
  callId: Schema.String, // the request_budget call the parent's answer settles
  reason: Schema.String,
  amount: Schema.Number,
  turn: Schema.optional(Schema.String),
  at: Schema.Number
})

export const BudgetGranted = Schema.Struct({
  type: Schema.Literal("BudgetGranted"),
  amount: Schema.Number, // the tool calls added to this turn's budget
  // The BudgetRequested this grant answers. The dedup key reads it: a grant is summed into the
  // ceiling (packages/agent/src/budget.ts), so a redelivered grant landing twice would silently
  // double the budget; keyed by the request it answers, the store absorbs the repeat.
  callId: Schema.optional(Schema.String),
  turn: Schema.optional(Schema.String),
  at: Schema.Number
})

export const BudgetDenied = Schema.Struct({
  type: Schema.Literal("BudgetDenied"),
  reason: Schema.optional(Schema.String),
  // The BudgetRequested this denial answers, for the dedup key; symmetry with BudgetGranted.
  callId: Schema.optional(Schema.String),
  turn: Schema.optional(Schema.String),
  at: Schema.Number
})

export const AgentEvent = Schema.Union([
  MessageReceived,
  ModelCalled,
  TextReturned,
  ToolCalled,
  ToolReturned,
  TurnCompleted,
  TurnFailed,
  ReplyDelivered,
  BudgetExhausted,
  BudgetRequested,
  BudgetGranted,
  BudgetDenied
])
export type AgentEvent = typeof AgentEvent.Type

// Action is what the model reacts with: ask the world, or end the turn. `text` is the prose the
// model emitted alongside a call; it records as `TextReturned`.
export type Action =
  | { readonly kind: "call"; readonly callId: string; readonly name: string; readonly arguments: unknown; readonly text?: string }
  | { readonly kind: "complete"; readonly output: string }
  | { readonly kind: "fail"; readonly error: string }

// agentKeys is the agent lane's dedup fragment, owned beside its alphabet. tr names the tool call's recorded
// pair; bg/bd name the budget request a decision answers (a grant is SUMMED into the ceiling,
// src/budget.ts, so a redelivered decision landing twice would double it). A decision that
// carries no callId predates the stamp and lands unkeyed; the fold tolerates it.
export const agentKeys: KeyFragment = {
  prefixes: ["tr:", "bg:", "bd:", "rd:", "tn:", "mc:", "bw:", "br:", "cc:"],
  keyOf: (e) => {
    const v = e as Record<string, unknown>
    switch (e.type) {
      case "ToolReturned":
        return `tr:${String(v.callId)}`
      case "BudgetGranted":
        return v.callId === undefined ? undefined : `bg:${String(v.callId)}`
      case "BudgetDenied":
        return v.callId === undefined ? undefined : `bd:${String(v.callId)}`
      case "ReplyDelivered":
        // One reply per turn.
        return `rd:${String(v.turn)}`
      case "TurnCompleted":
      case "TurnFailed":
        // One terminal per turn, whichever kind: a duplicate of either absorbs.
        return `tn:${String(v.turn)}`
      case "ModelCalled":
        // Occurrence-keyed marks: the ordinal is distinct per physical attempt, so the
        // repetition that evidences died attempts is preserved. A mark predating the ordinal
        // lands unkeyed, which the folds tolerate.
        return v.ordinal === undefined ? undefined : `mc:${String(v.turn)}/${String(v.ordinal)}`
      case "BudgetExhausted":
        // The wall's occurrence is the ceiling it fired at: a grant raises it, so a second
        // crossing keys anew.
        return `bw:${String(v.turn)}/${String(v.budget)}`
      case "BudgetRequested":
        return `br:${String(v.callId)}`
      case "CompactionCompleted":
        // The checkpoint's occurrence is the identity it keeps from.
        return `cc:${String(v.keepFrom)}`
      default:
        return undefined
    }
  }
}

// The alphabet's writing half: one constructor per letter (the rationale is
// packages/code/src/events.ts's; the gate is on the way in, never a new representation).

type Stamp = { readonly turn?: string; readonly at: number }

export const toolCalled = (
  fields: { readonly callId: string; readonly name: string; readonly arguments?: unknown } & Stamp
): Event => ({ type: "ToolCalled", ...fields }) as Event

export const toolReturned = (fields: { readonly callId: string; readonly result: unknown } & Stamp): Event =>
  ({ type: "ToolReturned", ...fields }) as Event

export const modelCalled = (
  fields: { readonly callId: string; readonly ordinal?: number } & Stamp
): Event => ({ type: "ModelCalled", ...fields }) as Event

export const textReturned = (fields: { readonly text: string } & Stamp): Event =>
  ({ type: "TextReturned", ...fields }) as Event

export const turnCompleted = (fields: { readonly output: string } & Stamp): Event =>
  ({ type: "TurnCompleted", ...fields }) as Event

export const turnFailed = (fields: { readonly error: string } & Stamp): Event =>
  ({ type: "TurnFailed", ...fields }) as Event

export const replyDelivered = (fields: { readonly turn: string; readonly to?: string; readonly at: number }): Event =>
  ({ type: "ReplyDelivered", ...fields }) as Event

export const budgetExhausted = (
  fields: { readonly budget: number; readonly used: number } & Stamp
): Event => ({ type: "BudgetExhausted", ...fields }) as Event

export const budgetRequested = (
  fields: { readonly callId: string; readonly reason: string; readonly amount: number } & Stamp
): Event => ({ type: "BudgetRequested", ...fields }) as Event

export const budgetGranted = (
  fields: { readonly amount: number; readonly callId?: string } & Stamp
): Event => ({ type: "BudgetGranted", ...fields }) as Event

export const budgetDenied = (
  fields: { readonly reason?: string; readonly callId?: string } & Stamp
): Event => ({ type: "BudgetDenied", ...fields }) as Event

export const compactionCompleted = (
  fields: { readonly keepFrom: string; readonly summary: string; readonly at: number }
): Event => ({ type: "CompactionCompleted", ...fields }) as Event
