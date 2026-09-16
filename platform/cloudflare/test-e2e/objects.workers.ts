import { SELF, env, evictDurableObject } from "cloudflare:test"
import { expect, test, vi } from "vitest"
import { Effect } from "effect"
import { ObjectStorage } from "@clavia/tardigrade-agent"
import { objectStorageFromR2, DEFAULT_R2_OBJECT_PREFIX } from "../src/object-storage/r2"

test("HTTP attachments warm the DO cache and replay after eviction with the backing object absent", async () => {
  const { OBJECTS: bucket, THREADS: threads } = env as { OBJECTS: R2Bucket; THREADS: DurableObjectNamespace }
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const object = await Effect.runPromise(Effect.gen(function* () {
    return yield* (yield* ObjectStorage).put(bytes)
  }).pipe(Effect.provide(objectStorageFromR2(bucket))))
  const seen: unknown[] = []
  const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    expect(new URL(request.url).hostname).toBe("provider.test")
    seen.push(await request.json())
    return new Response([
      { choices: [{ index: 0, delta: { content: "I read the image" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
    ].map(chunk => `data: ${JSON.stringify({ id: "image", model: "fixture", created: 1, ...chunk })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  })
  const fetch = (path: string, method = "GET", body?: unknown) => SELF.fetch(`http://test${path}`, {
    method, headers: { authorization: "Bearer fixture", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const base = "/v1/actors/main/threads/attachments"
  const call = async (id: string, input: unknown) => {
    const path = `${base}/methods/message/calls/${id}`
    expect((await fetch(path, "PUT", input)).status).toBe(202)
    await expect.poll(async () => (await (await fetch(path)).json() as { status: string }).status).toBe("completed")
    expect(await (await fetch(path)).json()).toMatchObject({ output: "I read the image" })
  }
  try {
    expect((await fetch("/v1/actors/main", "PUT")).status).toBe(200)
    expect((await fetch("/v1/actors/main/threads", "POST", { name: "attachments" })).status).toBe(200)
    await call("image", { content: [
      { type: "text", text: "Read this image" },
      { type: "file", mediaType: "image/png", object }
    ] })
    expect(seen).toHaveLength(1)
    const rows = await (await fetch(`${base}/events`)).json() as Array<{ event: { type: string; content?: unknown } }>
    expect(rows.find(row => row.event.type === "MessageReceived")?.event.content).toEqual([
      { type: "text", text: "Read this image" }, { type: "file", mediaType: "image/png", object }
    ])
    await bucket.delete(`${DEFAULT_R2_OBJECT_PREFIX}${object.algorithm}:${object.digest}`)
    await evictDurableObject(threads.getByName(JSON.stringify(["inference-test", "main", "attachments"])))
    await call("image", { text: "retry" })
    expect(seen).toHaveLength(1)
    await call("follow-up", { text: "What does it show?" })
    expect(seen).toHaveLength(2)
    for (const request of seen) expect(request).toMatchObject({ messages: expect.arrayContaining([
      expect.objectContaining({ role: "user", content: expect.arrayContaining([
        { type: "image_url", image_url: { url: `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`, detail: "auto" } }
      ]) })
    ]) })
  } finally {
    provider.mockRestore()
  }
})
