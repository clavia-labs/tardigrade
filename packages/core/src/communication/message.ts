import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import type { KeyFragment } from "../log"

// MessageReceived is the canonical inbound: an agent's turn, a mailbox's sink, a worker's brief, and a reply coming home are all this event. id is the dedup key everywhere. source names the arriving connection; chat and sender are provider coordinates; from is the delivering actor's address; input is a run's instance input; data is the provider's structured record. sender and from are separate namespaces on purpose: sender authored the message in the world, from delivered it here, receivers route by from and criteria match sender, so neither can impersonate the other.
export const MessageReceived = Schema.Struct({
  type: Schema.Literal("MessageReceived"),
  id: Schema.String,
  text: Schema.String,
  source: Schema.optional(Schema.String),
  chat: Schema.optional(Schema.String),
  sender: Schema.optional(Schema.String),
  from: Schema.optional(Schema.String),
  // The turn's declared output contract carries its schema identity and JSON Schema.
  output: Schema.optional(Schema.Struct({ name: Schema.String, schema: Schema.Unknown })),
  // outcome marks a method response. Method responses are not method calls because no declared method projects state for their ids (actor/method/response.test.ts, "returns a terminal through the accepted call link").
  outcome: Schema.optional(Schema.Literals(["completed", "failed", "cancelled", "requesting"])),
  input: Schema.optional(Schema.Unknown),
  // model carries consumer-owned selection data. The receiving actor defines its shape and meaning.
  model: Schema.optional(Schema.Unknown),
  data: Schema.optional(Schema.Unknown),
  at: Schema.Finite
})
export type MessageReceived = typeof MessageReceived.Type

// terminalReportOutcomeOf returns the terminal-report discriminator carried by a message.
export const terminalReportOutcomeOf = (
  message: { readonly outcome?: unknown }
): "completed" | "failed" | "cancelled" | undefined =>
  message.outcome === "completed" || message.outcome === "failed" || message.outcome === "cancelled"
    ? message.outcome
    : undefined

// messageKeys derives the core's own dedup key: a MessageReceived names its occurrence by id. The fragment lives beside the event it keys, the owner of the derivation.
export const messageKeys: KeyFragment = {
  prefixes: ["msg:"],
  keyOf: (event) => event.type === "MessageReceived" ? `msg:${String((event as { id?: unknown }).id)}` : undefined
}

// messageReceived constructs the canonical inbound. at is a parameter and id is the dedup key everywhere.
export const messageReceived = (fields: {
  readonly id: string
  readonly text: string
  readonly at: number
  readonly [extra: string]: unknown
}): Event => ({ type: "MessageReceived", ...fields }) as Event

// REPLY_SUFFIX is the reply convention: a reply answers id with id.reply, so a redelivery dedups against the same id at the receiver.
export const REPLY_SUFFIX = ".reply"
export const replyId = (id: string): string => `${id}${REPLY_SUFFIX}`

// boundaryId identifies one reported boundary of a turn. Round zero preserves the ordinary reply convention.
export const boundaryId = (turn: string, round: number): string =>
  round === 0 ? replyId(turn) : `${replyId(turn)}.${round}`

// boundaryEvent constructs one typed boundary report sent to a caller through a reversed link.
export const boundaryEvent = (args: {
  readonly turn: string
  readonly round: number
  readonly text: string
  readonly outcome: "completed" | "failed" | "cancelled" | "requesting"
  readonly from: string
  readonly data?: unknown
  readonly at: number
}): MessageReceived => ({
  type: "MessageReceived",
  id: boundaryId(args.turn, args.round),
  text: args.text,
  outcome: args.outcome,
  from: args.from,
  ...(args.data === undefined ? {} : { data: args.data }),
  at: args.at
})
