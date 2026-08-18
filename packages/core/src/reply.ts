import type { Envelope } from "./envelope"

// REPLY_SUFFIX is the reply convention: a reply answers id with id.reply, so a redelivery
// dedups against the same id at the receiver.
export const REPLY_SUFFIX = ".reply"
export const replyId = (id: string): string => `${id}${REPLY_SUFFIX}`

// replyEnvelope is the one shape agents and task runs send home when the caller named a
// replyTo. The receiver folds a plain MessageReceived with a typed outcome: no reader sniffs
// text for failure. The id is <id>.reply (src/grammar/grammar.ts), stable across redelivery,
// so the receiver dedups (tla/Delivery.tla, ReplyIntegrity).
export const replyEnvelope = (args: {
  readonly id: string
  readonly text: string
  readonly outcome: "completed" | "failed"
  readonly from: string
  readonly at: number
}): Envelope => ({
  type: "MessageReceived",
  id: replyId(args.id),
  text: args.text,
  outcome: args.outcome,
  from: args.from,
  at: args.at
})
