import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { ImageStore } from "@clavia/tardigrade-core/interaction/image"
import { historyOf } from "./prompt"
import { resolveMessageImages } from "./images"

const messages = [{ role: "user" as const, content: [
  { type: "input_image" as const, image_url: "image:fixture:jpeg", detail: "high" as const },
  { type: "input_text" as const, text: "compare" }
] }]

test("local image egress restores bytes, media type, order, and detail", async () => {
  const store: typeof ImageStore.Service = {
    egress: "resolve",
    owns: (reference) => reference.startsWith("image:fixture:"),
    put: () => Effect.succeed("image:fixture:jpeg"),
    get: () => Effect.succeed({ mediaType: "image/jpeg", bytes: new Uint8Array([98]) })
  }
  const resolved = await Effect.runPromise(resolveMessageImages(messages, store))
  const prompt = historyOf(resolved, { provider: "anthropic", protocol: "anthropic-messages", model: "claude" })[0]
  expect(prompt?.role === "user" ? prompt.content.map((part) => part.type === "file"
    ? { type: part.type, mediaType: part.mediaType, data: part.data, detail: part.options.openai?.imageDetail }
    : { type: part.type, text: part.text }) : []).toEqual([
    { type: "file", mediaType: "image/jpeg", data: "data:image/jpeg;base64,Yg==", detail: "high" },
    { type: "text", text: "compare" }
  ])
})

test("deferred image egress passes references without reading bytes", async () => {
  let reads = 0
  const store: typeof ImageStore.Service = {
    egress: "defer",
    owns: () => true,
    put: () => Effect.succeed("image:fixture:jpeg"),
    get: () => Effect.sync(() => { reads += 1; return { mediaType: "image/jpeg", bytes: new Uint8Array([98]) } })
  }
  expect(await Effect.runPromise(resolveMessageImages(messages, store))).toBe(messages)
  expect(reads).toBe(0)
})
