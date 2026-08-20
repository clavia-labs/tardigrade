import { Schema } from "effect"
import type { Event } from "./event"
import type { KeyFragment } from "./event-log"

// MessageReceived is the canonical inbound: an agent's turn, a mailbox's sink, a worker's
// brief, and a reply coming home are all this event. id is the dedup key everywhere. source
// names the arriving connection; chat and sender are provider coordinates; from is the
// delivering actor's address; replyTo is where the terminal reports; input is a run's instance
// input; data is the provider's structured record. sender and from are separate namespaces on
// purpose: sender authored the message in the world, from delivered it here, receivers route by
// from and criteria match sender, so neither can impersonate the other.
export const MessageReceived = Schema.Struct({
  type: Schema.Literal("MessageReceived"),
  id: Schema.String,
  text: Schema.String,
  source: Schema.optional(Schema.String),
  chat: Schema.optional(Schema.String),
  sender: Schema.optional(Schema.String),
  from: Schema.optional(Schema.String),
  replyTo: Schema.optional(Schema.String),
  output: Schema.optional(Schema.Unknown), // the expected output's JSON schema; structured turns end via the answer tool
  outcome: Schema.optional(Schema.Literals(["completed", "failed"])), // a reply's terminal, typed (replyEvent below)
  input: Schema.optional(Schema.Unknown),
  data: Schema.optional(Schema.Unknown),
  at: Schema.Number
})
export type MessageReceived = typeof MessageReceived.Type

// messageKeys derives the core's own dedup key: a MessageReceived names its occurrence by id.
// The fragment lives beside the event it keys, the owner of the derivation.
export const messageKeys: KeyFragment = {
  prefixes: ["msg:"],
  keyOf: (e) => (e.type === "MessageReceived" ? `msg:${String((e as { id?: unknown }).id)}` : undefined)
}

// messageReceived constructs the canonical inbound. `at` is a parameter, never a clock read;
// id is the dedup key everywhere.
export const messageReceived = (fields: {
  readonly id: string
  readonly text: string
  readonly at: number
  readonly [extra: string]: unknown
}): Event => ({ type: "MessageReceived", ...fields }) as Event

// REPLY_SUFFIX is the reply convention: a reply answers id with id.reply, so a redelivery
// dedups against the same id at the receiver.
export const REPLY_SUFFIX = ".reply"
export const replyId = (id: string): string => `${id}${REPLY_SUFFIX}`

// replyEvent is the shape agents and task runs send home when the caller named a replyTo.
// The receiver folds a plain MessageReceived with a typed outcome: no reader sniffs text for
// failure. The id is <id>.reply (REPLY_SUFFIX), stable across redelivery, and the receiver's
// msg: key absorbs a duplicate, so a second reply for the same call cannot land
// (tla/Delivery.tla, ReplyIntegrity).
export const replyEvent = (args: {
  readonly id: string
  readonly text: string
  readonly outcome: "completed" | "failed"
  readonly from: string
  readonly at: number
}): Event => ({
  type: "MessageReceived",
  id: replyId(args.id),
  text: args.text,
  outcome: args.outcome,
  from: args.from,
  at: args.at
})
