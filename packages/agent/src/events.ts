import { Schema } from "effect"
import { MessageReceived } from "@clavia/tardigrade-core/message"
import type { Event } from "@clavia/tardigrade-core/event"
import type { KeyFragment } from "@clavia/tardigrade-core/event-log"
import type { Usage } from "./usage"

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
export { MessageReceived } from "@clavia/tardigrade-core/message"

// ToolCalled is the ask: the turn calls a tool. `callId` correlates the return to this call.
export const ToolCalled = Schema.Struct({
  type: Schema.Literal("ToolCalled"),
  callId: Schema.String,
  name: Schema.String,
  arguments: Schema.Unknown,
  // The spend of the attempt this call answered (packages/agent/src/usage.ts). An empty object
  // is an attempt with unreported spend; an absent field is an event no attempt produced.
  usage: Schema.optional(Schema.Unknown),
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
// runs. A committed acting consequence after it is the answer, and that consequence's `usage`
// field is the attempt's spend. Consecutive `ModelCalled` with nothing between them are
// attempts that died, and the give-up guard reads that count.
export const ModelCalled = Schema.Struct({
  type: Schema.Literal("ModelCalled"),
  callId: Schema.String,
  // The occurrence: distinct per physical attempt, the dedup key's scope. callId stays the
  // provider idempotency key, shared across retries of one logical attempt.
  ordinal: Schema.optional(Schema.Number),
  // The output policy this attempt ran under, when the turn declared a contract: the schema
  // identity, the implementation that obtains it, and the guarantee the binding was asked for.
  // Recorded on the ask so a replay reads which policy produced which response.
  output: Schema.optional(
    Schema.Struct({
      contract: Schema.String,
      implementation: Schema.String,
      guarantee: Schema.Literals(["native", "none"])
    })
  ),
  epoch: Schema.optional(Schema.Number),
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
  usage: Schema.optional(Schema.Unknown),
  epoch: Schema.optional(Schema.Number),
  at: Schema.Number
})

// TURN_FAILURE_CAUSES are the failure classes a turn ends in, each distinct because each has a
// different remedy. `model` is a binding that reported nothing more specific; `inference_error`
// and `inference_attempts_exhausted` are transport; `refused` is a provider that declined to
// answer and `truncated` is one cut at its output ceiling, neither of which a retry of the same
// request fixes; `output_unsupported` is a contract the configured provider cannot obtain, found
// before anything is spent; `output_contract_violation` is a strict provider whose response
// missed the schema it guaranteed; `output_repairs_exhausted` is a correcting implementation
// that spent its bound (src/output.ts, OutputImplementation).
export const TURN_FAILURE_CAUSES = [
  "model",
  "inference_error",
  "inference_attempts_exhausted",
  "refused",
  "truncated",
  "output_unsupported",
  "output_contract_violation",
  "output_repairs_exhausted"
] as const

export type TurnFailureCause = (typeof TURN_FAILURE_CAUSES)[number]

// OutputRejected is one final response judged against the turn's declared output contract and
// found wanting. It is the state a correcting implementation runs on: the render shows the
// response back with its reasons, and the correction bound counts these
// (src/components/repair.ts). A turn under the native implementation records none: a mismatch
// there is the provider's own contract violation and ends the turn.
export const OutputRejected = Schema.Struct({
  type: Schema.Literal("OutputRejected"),
  contract: Schema.String, // the schema identity the response missed
  attempt: Schema.String, // the ModelCalled attempt whose response this was
  text: Schema.String, // the response verbatim: the durable evidence a projection never removes
  errors: Schema.Array(Schema.String),
  usage: Schema.optional(Schema.Unknown),
  epoch: Schema.optional(Schema.Number),
  turn: Schema.optional(Schema.String),
  at: Schema.Number
})

// TurnFailed is the failure terminal for one execution epoch.
export const TurnFailed = Schema.Struct({
  type: Schema.Literal("TurnFailed"),
  error: Schema.String,
  // Present only on the fail a live attempt answered; the give-up terminal carries none.
  usage: Schema.optional(Schema.Unknown),
  epoch: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Literals(TURN_FAILURE_CAUSES)),
  attempts: Schema.optional(Schema.Number),
  attemptKey: Schema.optional(Schema.String),
  policy: Schema.optional(Schema.Unknown),
  at: Schema.Number
})

// TurnResumed records the operator request that starts the next execution epoch.
export const TurnResumed = Schema.Struct({
  type: Schema.Literal("TurnResumed"),
  turn: Schema.String,
  failedEpoch: Schema.Number,
  epoch: Schema.Number,
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
  OutputRejected,
  TurnCompleted,
  TurnFailed,
  TurnResumed,
  ReplyDelivered,
  BudgetExhausted,
  BudgetRequested,
  BudgetGranted,
  BudgetDenied
])
export type AgentEvent = typeof AgentEvent.Type

// Action is what the model reacts with: ask the world, or end the turn. `text` is the prose the
// model emitted alongside a call; it records as `TextReturned`. A `complete` under a declared
// output contract carries the final response verbatim, and the infer reactor judges it against
// the contract before any terminal is recorded (runtime/infer.ts).
export type Action =
  | { readonly kind: "call"; readonly callId: string; readonly name: string; readonly arguments: unknown; readonly text?: string; readonly usage?: Usage }
  | { readonly kind: "complete"; readonly output: string; readonly usage?: Usage }
  | {
      readonly kind: "fail"
      readonly error: string
      readonly usage?: Usage
      readonly failure?: {
        readonly cause: TurnFailureCause
        readonly attempts: number
        readonly policy?: unknown
      }
    }

// agentKeys is the agent lane's dedup fragment, owned beside its alphabet. tr names the tool call's recorded
// pair; bg/bd name the budget request a decision answers (a grant is SUMMED into the ceiling,
// src/budget.ts, so a redelivered decision landing twice would double it). A decision that
// carries no callId predates the stamp and lands unkeyed; the fold tolerates it.
const epochSuffix = (epoch: unknown): string => epoch === undefined || Number(epoch) === 0 ? "" : `/${String(epoch)}`

export const agentKeys: KeyFragment = {
  prefixes: ["tr:", "bg:", "bd:", "rd:", "tn:", "rs:", "mc:", "bw:", "br:", "cc:", "or:"],
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
        // One reply per logical turn. A resumed boundary returns to its operator.
        return `rd:${String(v.turn)}`
      case "TurnCompleted":
      case "TurnFailed":
        // One terminal per turn epoch, whichever kind: a duplicate of either absorbs.
        return `tn:${String(v.turn)}${epochSuffix(v.epoch)}`
      case "TurnResumed":
        return `rs:${String(v.turn)}/${String(v.epoch)}`
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
      case "OutputRejected":
        // One rejection per logical attempt: a crashed attempt retried under the same key
        // records the same rejection, and the committed one binds.
        return `or:${String(v.attempt)}`
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
type EpochStamp = Stamp & { readonly epoch?: number }

export const toolCalled = (
  fields: { readonly callId: string; readonly name: string; readonly arguments?: unknown } & Stamp
): Event => ({ type: "ToolCalled", ...fields }) as Event

export const toolReturned = (fields: { readonly callId: string; readonly result: unknown } & Stamp): Event =>
  ({ type: "ToolReturned", ...fields }) as Event

export const modelCalled = (
  fields: { readonly callId: string; readonly ordinal?: number } & EpochStamp
): Event => ({ type: "ModelCalled", ...fields }) as Event

export const textReturned = (fields: { readonly text: string } & Stamp): Event =>
  ({ type: "TextReturned", ...fields }) as Event

export const turnCompleted = (fields: { readonly output: string } & EpochStamp): Event =>
  ({ type: "TurnCompleted", ...fields }) as Event

export const outputRejected = (
  fields: {
    readonly contract: string
    readonly attempt: string
    readonly text: string
    readonly errors: ReadonlyArray<string>
    readonly usage?: unknown
  } & EpochStamp
): Event => ({ type: "OutputRejected", ...fields }) as Event

export const turnFailed = (
  fields: {
    readonly error: string
    readonly cause?: TurnFailureCause
    readonly attempts?: number
    readonly attemptKey?: string
    readonly policy?: unknown
  } & EpochStamp
): Event =>
  ({ type: "TurnFailed", ...fields }) as Event

export const turnResumed = (fields: { readonly turn: string; readonly failedEpoch: number; readonly epoch: number; readonly at: number }): Event =>
  ({ type: "TurnResumed", ...fields }) as Event

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
