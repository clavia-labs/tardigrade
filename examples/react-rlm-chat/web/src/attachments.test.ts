import { expect, test } from "bun:test"
import { messageWithFiles } from "./attachments"

const policy = { maxUploadBytes: 4, mediaTypes: ["image/png"] }

test("text bypasses uploads and ordered files become references only after persistence", async () => {
  const uploaded: string[] = []
  const object = { algorithm: "sha256", digest: "a".repeat(64) } as const
  const request = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(init?.method).toBe("POST")
    uploaded.push(await new Response(init?.body).text())
    return Response.json({ object }, { status: 201 })
  }, { preconnect: fetch.preconnect })
  expect(await messageWithFiles("hello", [], "http://test", undefined, request)).toEqual({ text: "hello" })
  expect(uploaded).toEqual([])
  expect(await messageWithFiles("compare", [new File(["abc"], "first.png", { type: "image/png" }), new File(["def"], "second.png", { type: "image/png" })], "http://test", policy, request)).toEqual({ content: [
    { type: "text", text: "compare" },
    { type: "file", filename: "first.png", mediaType: "image/png", object },
    { type: "file", filename: "second.png", mediaType: "image/png", object }
  ] })
  expect(uploaded).toEqual(["abc", "def"])
  await expect(messageWithFiles("", [new File(["12345"], "large.png", { type: "image/png" })], "http://test", policy, request)).rejects.toThrow("upload limit")
  await expect(messageWithFiles("", [new File(["abc"], "file.png", { type: "image/png" })], "http://test", undefined, request)).rejects.toThrow("Upload policy is not available")
  expect(uploaded).toHaveLength(2)
})

test("failed uploads never produce message content", async () => {
  const request = Object.assign(async () => Response.json({ error: "Store unavailable" }, { status: 503 }), { preconnect: fetch.preconnect })
  await expect(messageWithFiles("", [new File(["abc"], "image.png", { type: "image/png" })], "http://test", policy, request)).rejects.toThrow("Store unavailable")
})
