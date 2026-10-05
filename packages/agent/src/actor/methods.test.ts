import { expect, test } from "bun:test"
import { Schema } from "effect"
import { AgentMessageInput } from "./methods"
import { TurnRequested } from "../contracts/events"
import { trajectoryState } from "../atoms/durable/trajectory"

const image = { algorithm: "sha256" as const, digest: "a".repeat(64) }
const content = [{ type: "text" as const, text: "describe" }, { type: "file" as const, mediaType: "image/png", object: image }]

test("message input accepts ordered content and rejects ambiguous shapes", () => {
  expect(Schema.decodeUnknownSync(AgentMessageInput)({ content })).toEqual({ content })
  expect(Schema.decodeUnknownSync(AgentMessageInput)({ text: "describe" })).toEqual({ text: "describe" })
  expect(() => Schema.decodeUnknownSync(AgentMessageInput)({ text: "describe", content })).toThrow("exactly one")
  expect(() => Schema.decodeUnknownSync(AgentMessageInput)({})).toThrow("exactly one")
})

test("content survives the durable message event and trajectory", () => {
  const event: typeof TurnRequested.Type = { type: "TurnRequested", turnId: "turn", text: "describe", content, source: "user" }
  expect(event).toEqual({ type: "TurnRequested", turnId: "turn", text: "describe", content, source: "user" })
  expect(trajectoryState({ entries: [], models: [] }, event).entries).toEqual([{ turnId: "turn", message: { role: "user", content } }])
})
