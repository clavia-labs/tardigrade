import { Schema } from "effect"
import { MessageReceived } from "@clavia/tardigrade-core/communication/message"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { KeyFragment } from "@clavia/tardigrade-core/log"
import type { Usage } from "../inference/usage"
import { ModelRef, type ModelRef as ModelRefType } from "../inference/reference"

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
export { MessageReceived } from "@clavia/tardigrade-core/communication/message"

// Endpoint is who served one attempt, recorded whether or not the endpoint reported any spend.
// `provider` and `model` are the configuration's own effective coordinates, so a replay reads
// which model supplied a native guarantee even when no usage came back; `routedProvider` and
// `routedModel` are the ones a router named on the wire, which supersede the configured pair as
// the observed truth (platform/model/src/model.ts, endpointOf).
export const Endpoint = Schema.Struct({
  provider: Schema.optional(Schema.String),
  model: Schema.String,
  routedProvider: Schema.optional(Schema.String),
  routedModel: Schema.optional(Schema.String)
})

// OutputPolicy is what one ask declared: the contract's identity and fingerprint, and the
// fallback the assembly mounted for a call native output cannot serve. The mode the attempt
// actually ran in is the binding's to report and lands on the consequence, because only the
// binding knows what the configured endpoint could promise (src/output/contract.ts, OutputFallback).
export const OutputPolicy = Schema.Struct({
  contract: Schema.String,
  fingerprint: Schema.String,
  fallback: Schema.optional(Schema.Unknown)
})

// ToolCalled is the ask: the turn calls a tool. `callId` correlates the return to this call.
export const ToolCalled = Schema.Struct({
  type: Schema.Literal("ToolCalled"),
  callId: Schema.String,
  name: Schema.String,
  arguments: Schema.Unknown,
  // The spend of the attempt this call answered (packages/agent/src/inference/usage.ts). An empty object
  // is an attempt with unreported spend; an absent field is an event no attempt produced.
  usage: Schema.optional(Schema.Unknown),
  endpoint: Schema.optional(Endpoint),
  // A tool call may be one response in a turn that declares final output. Its effective mode is
  // recorded here so replay does not decide how this attempt ran from a current capability
  // (inference/reactor.ts, consequenceOf).
  mode: Schema.optional(Schema.Unknown),
  at: Schema.Finite
})

// ToolReturned is the answer: the world's reply to one call. A failed call is a returned error,
// and the model reads it. Only the turn's own death is a `TurnFailed`.
export const ToolReturned = Schema.Struct({
  type: Schema.Literal("ToolReturned"),
  callId: Schema.String,
  result: Schema.Unknown,
  at: Schema.Finite
})

// ModelCalled is the ask to the model and the attempt mark in one, appended before the inference
// runs. A committed acting consequence after it is the answer, and that consequence's `usage`
// field is the attempt's spend. Consecutive `ModelCalled` with nothing between them are
// attempts that died, and the give-up guard reads that count.
export const ModelCalled = Schema.Struct({
  type: Schema.Literal("ModelCalled"),
  callId: Schema.String,
  model: Schema.optional(ModelRef),
  // The occurrence: distinct per physical attempt, the dedup key's scope. callId stays the
  // provider idempotency key, shared across retries of one logical attempt.
  ordinal: Schema.optional(Schema.Finite),
  // The output policy this attempt ran under, when the turn declared a contract. Recorded on the
  // ask, so a replay reads which policy produced which response.
  output: Schema.optional(OutputPolicy),
  epoch: Schema.optional(Schema.Finite),
  turn: Schema.optional(Schema.String),
  at: Schema.Finite
})

// ModelResolved records the model reference and catalog limits used by one turn.
export const ModelResolved = Schema.Struct({
  type: Schema.Literal("ModelResolved"),
  turn: Schema.String,
  model: ModelRef,
  contextWindowTokens: Schema.optional(Schema.Finite),
  maxOutputTokens: Schema.optional(Schema.Finite),
  catalogRevision: Schema.optional(Schema.String),
  at: Schema.Finite
})

// TextReturned is the prose the model emitted alongside its decision: working commentary,
// journaled and never delivered. The final answer is `TurnCompleted.output`, never this.
export const TextReturned = Schema.Struct({
  type: Schema.Literal("TextReturned"),
  text: Schema.String,
  at: Schema.Finite
})

// TurnCompleted is the success terminal, under every policy. The event carries the output.
export const TurnCompleted = Schema.Struct({
  type: Schema.Literal("TurnCompleted"),
  output: Schema.String,
  usage: Schema.optional(Schema.Unknown),
  // The ModelCalled this terminal answers, who served it, and the output mode it ran in. The
  // three join the ask's recorded policy to the answer it produced without reading another event
  // (src/output/contract.ts, OutputMode).
  attemptKey: Schema.optional(Schema.String),
  endpoint: Schema.optional(Endpoint),
  mode: Schema.optional(Schema.Unknown),
  epoch: Schema.optional(Schema.Finite),
  at: Schema.Finite
})

// TURN_FAILURE_CAUSES are the failure classes a turn ends in, each distinct because each has a
// different remedy. `model` is a binding that reported nothing more specific; `inference_error`
// and `inference_attempts_exhausted` are transport; `refused` is a provider that declined to
// answer and `truncated` is one cut at its output ceiling, neither of which a retry of the same
// request fixes; `output_unsupported` is a contract the configured provider cannot obtain, found
// before anything is spent; `output_contract_violation` is an endpoint that promised a native
// strict guarantee and broke it; `output_validation_failed` is a response a developer chose to
// validate locally and fail on rather than correct; `output_repairs_exhausted` is the framework
// correction loop spending its bound (src/output/contract.ts, OutputMode).
export const TURN_FAILURE_CAUSES = [
  "model",
  "inference_error",
  "inference_attempts_exhausted",
  "refused",
  "truncated",
  "output_unsupported",
  "output_contract_violation",
  "output_validation_failed",
  "output_repairs_exhausted"
] as const

export type TurnFailureCause = (typeof TURN_FAILURE_CAUSES)[number]

// OutputRejected is one final response judged against the turn's declared output contract and
// found wanting. It is the typed state a correcting implementation runs on: the framework loop
// counts these against its recorded bound, and a delegated one derives whatever it likes from
// them (src/components/repair.ts). A turn under the native or local implementation records none:
// a mismatch there is a terminal.
//
// `mode` is how the attempt that produced it obtained the contract, recorded here because
// exhaustion, the park, and the history projection are all read off this event and must not
// change when a deployment mounts a different fallback (src/output/contract.ts, projectedOutput).
export const OutputRejected = Schema.Struct({
  type: Schema.Literal("OutputRejected"),
  contract: Schema.String, // the schema identity the response missed
  fingerprint: Schema.optional(Schema.String),
  attempt: Schema.String, // the ModelCalled attempt whose response this was
  text: Schema.String, // the response verbatim: the durable evidence a projection never removes
  errors: Schema.Array(Schema.String),
  mode: Schema.optional(Schema.Unknown),
  usage: Schema.optional(Schema.Unknown),
  endpoint: Schema.optional(Endpoint),
  epoch: Schema.optional(Schema.Finite),
  turn: Schema.optional(Schema.String),
  at: Schema.Finite
})

// OutputRetryRequested is a component's decision that a rejected response should be asked again,
// with the feedback that component chose. It states the request rather than the retry: a process
// that dies between this record and the inference leaves a request nobody served, and the
// `ModelCalled` that follows is the durable fact that the ask began (ModelCalled above).
//
// It exists so a delegated implementation owns its own loop: the infer reactor parks a delegated
// turn on its rejection and only this event releases it, and the render shows `feedback` rather
// than any framework sentence. `decision` is the component's own serializable record of why,
// stamped so a replay reads the same choice (src/output/contract.ts, OutputFallback).
export const OutputRetryRequested = Schema.Struct({
  type: Schema.Literal("OutputRetryRequested"),
  rejection: Schema.String, // the OutputRejected attempt this answers
  feedback: Schema.String,
  by: Schema.String, // the component that decided
  decision: Schema.optional(Schema.Unknown),
  epoch: Schema.optional(Schema.Finite),
  turn: Schema.optional(Schema.String),
  at: Schema.Finite
})

// TurnFailed is the failure terminal for one execution epoch.
export const TurnFailed = Schema.Struct({
  type: Schema.Literal("TurnFailed"),
  error: Schema.String,
  // Present only on the fail a live attempt answered; the give-up terminal carries none.
  usage: Schema.optional(Schema.Unknown),
  epoch: Schema.optional(Schema.Finite),
  cause: Schema.optional(Schema.Literals(TURN_FAILURE_CAUSES)),
  attempts: Schema.optional(Schema.Finite),
  attemptKey: Schema.optional(Schema.String),
  policy: Schema.optional(Schema.Unknown),
  mode: Schema.optional(Schema.Unknown),
  endpoint: Schema.optional(Endpoint),
  at: Schema.Finite
})

// TurnResumed records the operator request that starts the next execution epoch.
export const TurnResumed = Schema.Struct({
  type: Schema.Literal("TurnResumed"),
  turn: Schema.String,
  failedEpoch: Schema.Finite,
  epoch: Schema.Finite,
  at: Schema.Finite
})

// BudgetExhausted records the wall when a component subtree passes the turn's budget. The budget
// wrapper withdraws its tools and refuses the pending call (components/budget.test.ts, "settling an
// over-budget execute records the wall and never dispatches the call").
export const BudgetExhausted = Schema.Struct({
  type: Schema.Literal("BudgetExhausted"),
  budget: Schema.Finite,
  used: Schema.Finite,
  turn: Schema.optional(Schema.String),
  at: Schema.Finite
})

// BudgetRequested opens the escalation lifecycle. At its wall an escalatable agent records the ask, calls its parent's requestBudget method, and remains pending until the decision reopens or closes the budget.
export const BudgetRequested = Schema.Struct({
  type: Schema.Literal("BudgetRequested"),
  callId: Schema.String, // the request_budget call the parent's answer settles
  reason: Schema.String,
  amount: Schema.Finite,
  turn: Schema.optional(Schema.String),
  at: Schema.Finite
})

// BudgetRequestReceived is the durable input of the requestBudget actor method.
export const BudgetRequestReceived = Schema.Struct({
  type: Schema.Literal("BudgetRequestReceived"),
  id: Schema.String,
  request: Schema.String,
  turn: Schema.String,
  reason: Schema.String,
  amount: Schema.Finite,
  at: Schema.Finite
})

// BudgetRequestDecided is the terminal decision produced by a budget authority.
export const BudgetRequestDecided = Schema.Struct({
  type: Schema.Literal("BudgetRequestDecided"),
  callId: Schema.String,
  grant: Schema.Finite,
  reason: Schema.optional(Schema.String),
  at: Schema.Finite
})

// BudgetRequestFailed is the terminal failure produced when an authority cannot decide a request.
export const BudgetRequestFailed = Schema.Struct({
  type: Schema.Literal("BudgetRequestFailed"),
  callId: Schema.String,
  error: Schema.String,
  at: Schema.Finite
})

// PermissionRequestReceived is the durable input of the requestPermission actor method.
export const PermissionRequestReceived = Schema.Struct({
  type: Schema.Literal("PermissionRequestReceived"),
  id: Schema.String,
  request: Schema.String,
  turn: Schema.String,
  tool: Schema.String,
  action: Schema.String,
  resource: Schema.optional(Schema.String),
  reason: Schema.String,
  at: Schema.Finite
})

// PermissionRequestDecided is the terminal decision produced by a permission authority.
export const PermissionRequestDecided = Schema.Struct({
  type: Schema.Literal("PermissionRequestDecided"),
  callId: Schema.String,
  granted: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  at: Schema.Finite
})

// PermissionRequestFailed is the terminal failure produced when a permission authority cannot decide a request.
export const PermissionRequestFailed = Schema.Struct({
  type: Schema.Literal("PermissionRequestFailed"),
  callId: Schema.String,
  error: Schema.String,
  at: Schema.Finite
})

export const BudgetGranted = Schema.Struct({
  type: Schema.Literal("BudgetGranted"),
  amount: Schema.Finite, // the tool calls added to this turn's budget
  // The BudgetRequested this grant answers. The dedup key reads it: a grant is summed into the
  // ceiling (components/budget.ts), so a redelivered grant landing twice would silently
  // double the budget; keyed by the request it answers, the store absorbs the repeat.
  callId: Schema.optional(Schema.String),
  turn: Schema.optional(Schema.String),
  at: Schema.Finite
})

export const BudgetDenied = Schema.Struct({
  type: Schema.Literal("BudgetDenied"),
  reason: Schema.optional(Schema.String),
  // The BudgetRequested this denial answers, for the dedup key; symmetry with BudgetGranted.
  callId: Schema.optional(Schema.String),
  turn: Schema.optional(Schema.String),
  at: Schema.Finite
})

export const AgentEvent = Schema.Union([
  MessageReceived,
  ModelResolved,
  ModelCalled,
  TextReturned,
  ToolCalled,
  ToolReturned,
  OutputRejected,
  OutputRetryRequested,
  TurnCompleted,
  TurnFailed,
  TurnResumed,
  BudgetExhausted,
  BudgetRequested,
  BudgetRequestReceived,
  BudgetRequestDecided,
  BudgetRequestFailed,
  PermissionRequestReceived,
  PermissionRequestDecided,
  PermissionRequestFailed,
  BudgetGranted,
  BudgetDenied
])
export type AgentEvent = typeof AgentEvent.Type

// Action is what the model reacts with: ask the world, or end the turn. `text` is the prose the
// model emitted alongside a call; it records as `TextReturned`. A `complete` under a declared
// output contract carries the final response verbatim, and the infer reactor judges it against
// the contract before any terminal is recorded (inference/reactor.ts).
// AttemptEndpoint is the binding's report of who served the attempt, carried on every action so
// the consequence records it whether or not the endpoint reported any spend.
export interface AttemptEndpoint {
  readonly provider?: string
  readonly model: string
  readonly routedProvider?: string
  readonly routedModel?: string
}

// `mode` is how an attempt obtained a declared output contract. A binding answering a turn that
// declared one must state it: the reactor records it and reads it back on replay, and it refuses
// to invent one (inference/reactor.ts, completionOf).
type Served = {
  readonly usage?: Usage
  readonly endpoint?: AttemptEndpoint
  readonly mode?: import("../output/contract").OutputMode
}

export type Action =
  | ({ readonly kind: "call"; readonly callId: string; readonly name: string; readonly arguments: unknown; readonly text?: string } & Served)
  | ({ readonly kind: "complete"; readonly output: string } & Served)
  | ({
      readonly kind: "fail"
      readonly error: string
      readonly failure?: {
        readonly cause: TurnFailureCause
        readonly attempts: number
        readonly policy?: unknown
      }
    } & Served)

// agentKeys is the agent lane's dedup fragment, owned beside its alphabet. tr names the tool call's recorded
// pair; bdec names the budget request a local decision answers, so a grant and denial for one request
// cannot both commit. A grant is summed into the ceiling, so a redelivery must also absorb. A
// decision that carries no callId predates the stamp and lands unkeyed; the fold tolerates it.
const epochSuffix = (epoch: unknown): string => epoch === undefined || Number(epoch) === 0 ? "" : `/${String(epoch)}`

export const agentKeys: KeyFragment = {
  prefixes: ["tr:", "bdec:", "tn:", "rs:", "mr:", "mc:", "bw:", "br:", "cc:", "or:", "oq:"],
  keyOf: (e) => {
    const v = e as Record<string, unknown>
    switch (e.type) {
      case "ToolReturned":
        return `tr:${String(v.callId)}`
      case "BudgetGranted":
        return v.callId === undefined ? undefined : `bdec:${String(v.callId)}`
      case "BudgetDenied":
        return v.callId === undefined ? undefined : `bdec:${String(v.callId)}`
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
      case "ModelResolved":
        return `mr:${String(v.turn)}`
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
      case "OutputRetryRequested":
        // One decision per rejection, whichever component made it.
        return `oq:${String(v.rejection)}`
      case "CompactionCompleted":
        // The checkpoint's occurrence is the identity it keeps from.
        return `cc:${String(v.keepFrom)}`
      default:
        return undefined
    }
  }
}

// The alphabet's writing half: one constructor per letter (the rationale is
// packages/code/src/execution/events.ts's; the gate is on the way in, never a new representation).

type Stamp = { readonly turn?: string; readonly at: number }
type EpochStamp = Stamp & { readonly epoch?: number }

export const toolCalled = (
  fields: {
    readonly callId: string
    readonly name: string
    readonly arguments?: unknown
    readonly mode?: unknown
  } & Stamp
): Event => ({ type: "ToolCalled", ...fields }) as Event

export const toolReturned = (fields: { readonly callId: string; readonly result: unknown } & Stamp): Event =>
  ({ type: "ToolReturned", ...fields }) as Event

export const modelCalled = (
  fields: {
    readonly callId: string
    readonly model?: ModelRefType
    readonly ordinal?: number
    readonly output?: {
      readonly contract: string
      readonly fingerprint: string
      readonly fallback?: unknown
    }
  } & EpochStamp
): Event => ({ type: "ModelCalled", ...fields }) as Event

export const modelResolved = (fields: {
  readonly turn: string
  readonly model: ModelRefType
  readonly contextWindowTokens?: number
  readonly maxOutputTokens?: number
  readonly catalogRevision?: string
  readonly at: number
}): Event =>
  ({ type: "ModelResolved", ...fields }) as Event

export const textReturned = (fields: { readonly text: string } & Stamp): Event =>
  ({ type: "TextReturned", ...fields }) as Event

export const turnCompleted = (
  fields: {
    readonly output: string
    readonly attemptKey?: string
    readonly mode?: unknown
    readonly endpoint?: unknown
  } & EpochStamp
): Event => ({ type: "TurnCompleted", ...fields }) as Event

export const outputRejected = (
  fields: {
    readonly contract: string
    readonly fingerprint?: string
    readonly attempt: string
    readonly text: string
    readonly errors: ReadonlyArray<string>
    readonly mode?: unknown
    readonly usage?: unknown
    readonly endpoint?: unknown
  } & EpochStamp
): Event => ({ type: "OutputRejected", ...fields }) as Event

// outputRetryRequested records one component's decision to ask again after a rejection, with the
// feedback that component chose. Any component may append it; the infer reactor reads only
// whether the rejection it answers has one (inference/reactor.ts).
export const outputRetryRequested = (
  fields: {
    readonly rejection: string
    readonly feedback: string
    readonly by: string
    readonly decision?: unknown
  } & EpochStamp
): Event => ({ type: "OutputRetryRequested", ...fields }) as Event

export const turnFailed = (
  fields: {
    readonly error: string
    readonly cause?: TurnFailureCause
    readonly attempts?: number
    readonly attemptKey?: string
    readonly policy?: unknown
    readonly endpoint?: unknown
  } & EpochStamp
): Event =>
  ({ type: "TurnFailed", ...fields }) as Event

export const turnResumed = (fields: { readonly turn: string; readonly failedEpoch: number; readonly epoch: number; readonly at: number }): Event =>
  ({ type: "TurnResumed", ...fields }) as Event

export const budgetExhausted = (
  fields: { readonly budget: number; readonly used: number } & Stamp
): Event => ({ type: "BudgetExhausted", ...fields }) as Event

export const budgetRequested = (
  fields: { readonly callId: string; readonly reason: string; readonly amount: number } & Stamp
): Event => ({ type: "BudgetRequested", ...fields }) as Event

export const budgetRequestReceived = (
  fields: { readonly id: string; readonly request: string; readonly turn: string; readonly reason: string; readonly amount: number; readonly at: number }
): Event => ({ type: "BudgetRequestReceived", ...fields }) as Event

export const budgetRequestDecided = (
  fields: { readonly callId: string; readonly grant: number; readonly reason?: string; readonly at: number }
): Event => ({ type: "BudgetRequestDecided", ...fields }) as Event

export const budgetRequestFailed = (
  fields: { readonly callId: string; readonly error: string; readonly at: number }
): Event => ({ type: "BudgetRequestFailed", ...fields }) as Event

export const permissionRequestReceived = (
  fields: { readonly id: string; readonly request: string; readonly turn: string; readonly tool: string; readonly action: string; readonly resource?: string; readonly reason: string; readonly at: number }
): Event => ({ type: "PermissionRequestReceived", ...fields }) as Event

export const permissionRequestDecided = (
  fields: { readonly callId: string; readonly granted: boolean; readonly reason?: string; readonly at: number }
): Event => ({ type: "PermissionRequestDecided", ...fields }) as Event

export const permissionRequestFailed = (
  fields: { readonly callId: string; readonly error: string; readonly at: number }
): Event => ({ type: "PermissionRequestFailed", ...fields }) as Event

export const budgetGranted = (
  fields: { readonly amount: number; readonly callId?: string } & Stamp
): Event => ({ type: "BudgetGranted", ...fields }) as Event

export const budgetDenied = (
  fields: { readonly reason?: string; readonly callId?: string } & Stamp
): Event => ({ type: "BudgetDenied", ...fields }) as Event

export const compactionCompleted = (
  fields: {
    readonly keepFrom: string
    readonly summary: string
    readonly contextWindowTokens: number
    readonly fireTokens: number
    readonly keepTokens: number
    readonly at: number
  }
): Event => ({ type: "CompactionCompleted", ...fields }) as Event
