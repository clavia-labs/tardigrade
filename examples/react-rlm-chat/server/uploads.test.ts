import { expect, test } from "bun:test"
import { Effect } from "effect"
import { makeObjectStorage } from "tardie/agent"
import { DEFAULT_MAX_UPLOAD_BYTES, uploadLimit, uploadResponse } from "./uploads"

test("uploads validate type and size and persist before returning a reference", async () => {
  const objects = new Map<string, Uint8Array>()
  const storage = makeObjectStorage({ read: key => Effect.succeed(objects.get(key)), write: (key, bytes) => Effect.sync(() => { objects.set(key, bytes) }) })
  const options = { maxUploadBytes: 4 }
  const send = (body: string, headers: Record<string, string> = {}) => uploadResponse(new Request("http://test/v1/objects", {
    method: "POST", headers: { "content-type": "image/png", ...headers }, body
  }), storage, options)
  expect((await send("abc", { "content-type": "text/html" })).status).toBe(415)
  expect((await send("12345")).status).toBe(413)
  expect((await send("")).status).toBe(400)
  expect(objects.size).toBe(0)
  const response = await send("1234")
  expect(response.status).toBe(201)
  const { object } = await response.json()
  expect(await Effect.runPromise(storage.get(object))).toEqual(new TextEncoder().encode("1234"))
  expect(await (await send("1234")).json()).toEqual({ object })
  expect(objects.size).toBe(1)
  const policy = await uploadResponse(new Request("http://test/v1/objects"), storage, options)
  expect(await policy.json()).toMatchObject({ maxUploadBytes: 4 })
})

test("streamed uploads enforce the actual size and backing failures return no reference", async () => {
  let writes = 0
  let cancelled = false
  const storage = makeObjectStorage({ read: () => Effect.succeed(undefined), write: () => Effect.try(() => { writes++; throw new Error("offline") }) })
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(3)) }, cancel() { cancelled = true } })
  const response = await uploadResponse(new Request("http://test/v1/objects", { method: "POST", headers: { "content-type": "image/png" }, body }), storage, { maxUploadBytes: 4 })
  expect(response.status).toBe(413)
  expect(cancelled).toBe(true)
  expect(writes).toBe(0)
  const failed = await uploadResponse(new Request("http://test/v1/objects", { method: "POST", headers: { "content-type": "image/png" }, body: "abc" }), storage, { maxUploadBytes: 4 })
  expect(failed.status).toBe(503)
  expect(await failed.json()).not.toHaveProperty("object")
  expect(uploadLimit()).toBe(DEFAULT_MAX_UPLOAD_BYTES)
  expect(uploadLimit("4")).toBe(4)
  for (const value of ["0", "-1", "NaN", "1.5"]) expect(() => uploadLimit(value)).toThrow()
})
