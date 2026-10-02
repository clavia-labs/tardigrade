import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { AgentMessageInput } from "../actor/message"
import { MessageContent } from "./message"

const object = {
  algorithm: "sha256" as const,
  digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
}
const file = { type: "file" as const, mediaType: "application/pdf", filename: "q1.pdf", object }
const decodeContent = Schema.decodeUnknownSync(MessageContent)
const decodeInput = (content: unknown) => Schema.decodeUnknownSync(AgentMessageInput)({ content })

describe("message content boundary", () => {
  test("replays ordered text and attachments with per-message metadata", () => {
    const content: MessageContent = [
      { type: "text", text: "Compare these reports" },
      file,
      { type: "text", text: "This is another name for the same bytes" },
      { ...file, filename: "copy.pdf" }
    ]
    expect(decodeContent(JSON.parse(JSON.stringify(content)))).toEqual(content)
    expect(decodeInput(content)).toEqual({ content })
  })

  test("rejects inline bytes and ambiguous file sources at message receipt", () => {
    const inline = { type: "file" as const, mediaType: "image/png", data: new Uint8Array([1, 2, 3]) }
    expect(() => decodeInput([inline])).toThrow()
    expect(() => decodeContent([inline])).toThrow()
    expect(() => decodeContent([{ ...file, data: inline.data }])).toThrow()
    expect(() => decodeInput([{ ...file, data: inline.data }])).toThrow()
    expect(() => decodeInput([{ type: "file", mediaType: "image/png" }])).toThrow()
  })

  test("refuses malformed durable references and implicit string or JSON byte encodings", () => {
    expect(() => decodeContent([{ ...file, object: { algorithm: "sha256" as const, digest: "abc123" } }])).toThrow()
    for (const data of ["object:abc123", "AQID", [1, 2, 3], { 0: 1, 1: 2, 2: 3 }]) {
      expect(() => decodeInput([{ type: "file", mediaType: "image/png", data }])).toThrow()
    }
  })
})
