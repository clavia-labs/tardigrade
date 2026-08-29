import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ThreadAddress } from "./endpoint"
import { envelopeOf, linkedEventOf } from "./envelope"
import { linkOf, reverseLink } from "./link"

describe("links", () => {
  test("connects a source-specific address to an actor thread", () => {
    const source = {
      bot: "support_bot",
      chat: "-1001234567890",
      topic: "42"
    }
    const target = Schema.decodeSync(ThreadAddress)({
      actor: "support",
      instance: "main",
      thread: "telegram:-1001234567890:42"
    })

    expect(linkOf(source, target)).toEqual({ source, target })
  })

  test("reversing twice preserves both endpoint identities", () => {
    const source = { actor: "release-analyst", instance: "main", thread: "release-42" }
    const target = { actor: "reviewer", instance: "main", thread: "review-42" }
    const link = linkOf(source, target)

    const reversed = reverseLink(link)

    expect(reversed).toEqual({ source: target, target: source })
    expect(reverseLink(reversed)).toEqual(link)
  })

  test("a delivery retains its link and event", () => {
    const link = linkOf(
      { workspace: "T012ACME", channel: "C078SUPPORT" },
      { actor: "support", instance: "main", thread: "incident-42" }
    )
    const event = { type: "MessageReceived" as const, id: "m1", text: "hello", at: 42 }

    expect(envelopeOf(link, event)).toEqual({ link, event })
  })

  test("a linked event retains the accepted route in the log value", () => {
    const link = linkOf(
      { provider: "telegram-support", chat: "-1001234567890", topic: 42 },
      { actor: "support", instance: "main", thread: "incident-42" }
    )
    const event = { type: "MessageReceived" as const, id: "m1", text: "hello", at: 42 }

    expect(linkedEventOf(envelopeOf(link, event))).toEqual({ ...event, link })
  })
})
