import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Event } from "../event"
import { resolveImageSource, storeEventImages, type StoredImage } from "./image"

const memoryStore = (fail = false) => {
  const values = new Map<string, StoredImage>()
  return {
    values,
    service: {
      owns: (reference: string) => reference.startsWith("image:fixture:"),
      put: (image: StoredImage) => fail
        ? Effect.die(new Error("image store unavailable"))
        : Effect.sync(() => {
            const reference = `image:fixture:${image.bytes.toHex()}`
            values.set(reference, image)
            return reference
          }),
      get: (reference: string) => Effect.succeed(values.get(reference))
    }
  }
}

describe("stored image events", () => {
  test("stores message images in order and keeps non-image sources", async () => {
    const store = memoryStore()
    const events = [{
      type: "MessageReceived", id: "picture", at: 1, content: [
        { type: "input_image", image_url: "data:image/png;base64,YQ==", detail: "low" },
        { type: "input_text", text: "compare" },
        { type: "input_image", image_url: "https://fixture.invalid/b.png" }
      ]
    }] as Event[]
    const stored = await Effect.runPromise(storeEventImages(events, store.service))
    expect(stored).toEqual([{ ...events[0]!, content: [
      { type: "input_image", image_url: "image:fixture:61", detail: "low" },
      { type: "input_text", text: "compare" },
      { type: "input_image", image_url: "https://fixture.invalid/b.png" }
    ] }])
    expect(await Effect.runPromise(resolveImageSource("image:fixture:61", store.service))).toBe("data:image/png;base64,YQ==")
  })

  test("stores native message call input before its plan is appended", async () => {
    const store = memoryStore()
    const planned = {
      type: "CallPlanned", id: "call", method: "message", target: "mem:a:i:t", at: 1,
      input: { content: [{ type: "input_image", image_url: "data:image/jpeg;base64,Yg==" }] }
    } as Event
    expect(await Effect.runPromise(storeEventImages([planned], store.service))).toEqual([{
      ...planned, input: { content: [{ type: "input_image", image_url: "image:fixture:62" }] }
    }])
  })

  test("checks the byte limit before calling the store", async () => {
    let puts = 0
    const store = memoryStore()
    const service = { ...store.service, put: (image: StoredImage) => Effect.sync(() => { puts += 1; return `image:${image.bytes.length}` }) }
    const events = [{ type: "MessageReceived", id: "picture", at: 1, content: [
      { type: "input_image", image_url: "data:image/png;base64,YQ==" },
      { type: "input_image", image_url: "data:image/png;base64,YWI=" }
    ] }] as Event[]
    await expect(Effect.runPromise(storeEventImages(events, service, { maxBytes: 1 }))).rejects.toThrow("above the 1-byte limit")
    expect(puts).toBe(0)
  })

  test("leaves old inline events readable when no append normalization runs", () => {
    const event = { type: "MessageReceived", id: "old", at: 1, content: [{ type: "input_image", image_url: "data:image/png;base64,YQ==" }] }
    expect(event.content[0]?.image_url).toBe("data:image/png;base64,YQ==")
  })
})
