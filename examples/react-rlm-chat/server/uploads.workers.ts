import { SELF, env, evictDurableObject, runInDurableObject } from "cloudflare:test"
import { expect, test, vi } from "vitest"
import type { ObjectRef } from "tardie/agent"

test("chat uploads to R2 without sign-in and replays attachments after DO eviction", async () => {
  const fetch = (path: string, method = "GET", body?: unknown) => SELF.fetch(`https://chat.test${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const upload = await SELF.fetch("https://chat.test/v1/objects", { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([137, 80, 78, 71]) })
  expect(upload.status).toBe(201)
  const { object } = await upload.json() as { object: ObjectRef }
  const bindings = env as { THREADS: DurableObjectNamespace; OBJECTS: R2Bucket }
  const requests: unknown[] = []
  let finishFirst: (() => void) | undefined
  const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    expect(new URL(request.url).hostname).toBe("openrouter.ai")
    requests.push(await request.json())
    const frames = [
      { choices: [{ index: 0, delta: { content: "I read the image" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }
    ].map(chunk => `data: ${JSON.stringify({ id: "image", object: "chat.completion.chunk", model: "openai/gpt-5.6-sol", created: 1, ...chunk })}\n\n`)
    const encoder = new TextEncoder()
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encoder.encode(frames[0]))
      const finish = () => { controller.enqueue(encoder.encode(frames[1] + "data: [DONE]\n\n")); controller.close() }
      if (requests.length === 1) finishFirst = finish
      else finish()
    } }), { headers: { "content-type": "text/event-stream" } })
  })
  try {
    expect((await fetch("/v1/actors/main", "PUT")).status).toBe(200)
    expect((await fetch("/v1/actors/main/threads", "POST", { name: "files" })).status).toBe(200)
    const call = async (id: string, input: unknown) => {
      const path = `/v1/actors/main/threads/files/methods/message/calls/${id}`
      expect((await fetch(path, "PUT", input)).status).toBe(202)
      await expect.poll(async () => (await (await fetch(path)).json() as { status: string }).status, { timeout: 10000 }).not.toBe("pending")
      const result = await (await fetch(path)).json()
      expect(result, JSON.stringify(result)).toMatchObject({ status: "completed", output: "I read the image" })
    }
    const stream = await fetch("/v1/actors/main/threads/files/inference/stream")
    expect(stream.status).toBe(200)
    const reader = stream.body!.getReader()
    const completed = call("image", { content: [{ type: "file", filename: "chart.png", mediaType: "image/png", object }] })
    try {
      let frames = ""
      while (!frames.includes('"text":"I read the image"')) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error("inference stream closed before delivering text")
        frames += new TextDecoder().decode(chunk.value)
      }
      expect(frames).toContain('"thread":"files"')
    } finally {
      await runInDurableObject(bindings.THREADS.getByName(JSON.stringify(["react-chat", "main", "files"])), () => { finishFirst?.() })
      try { await completed } finally { await reader.cancel() }
    }
    await evictDurableObject(bindings.THREADS.getByName(JSON.stringify(["react-chat", "main", "files"])))
    await bindings.OBJECTS.delete(`objects/${object.algorithm}:${object.digest}`)
    await call("again", { text: "Read it again" })
    expect(requests).toHaveLength(2)
    for (const request of requests) expect(JSON.stringify(request)).toContain("data:image/png;base64,iVBORw==")
  } finally { provider.mockRestore() }
}, 20000)
