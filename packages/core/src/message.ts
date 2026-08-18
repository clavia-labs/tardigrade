import { Schema } from "effect"
import type { Envelope } from "./envelope"
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
}): Envelope => ({ type: "MessageReceived", ...fields }) as Envelope
