import { SELF, env } from "cloudflare:test"
import type { Env } from "../src/env"
import { expect, test } from "vitest"

const authorization = { authorization: "Bearer workers-test-token" }
const base = "http://test/v1/actors/stream-test"
const open = async (path: string, headers: Record<string, string> = authorization) => {
  const response = await SELF.fetch(`${base}${path}`, { headers })
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  const reader = response.body!.getReader()
  let pending = ""
  return {
    close: () => reader.cancel(),
    next: async (): Promise<{ seq: number; event: { type: string; [key: string]: unknown } }> => {
      for (;;) {
        const boundary = pending.indexOf("\n\n")
        if (boundary < 0) {
          const chunk = await reader.read()
          if (chunk.done) throw new Error("stream ended before event")
          pending += new TextDecoder().decode(chunk.value)
          continue
        }
        const frame = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        const data = frame.split("\n").find((line) => line.startsWith("data: "))
        if (data === undefined) continue
        const id = frame.split("\n").find((line) => line.startsWith("id: "))
        return { seq: Number(id?.slice(4)), event: JSON.parse(data.slice(6)) }
      }
    }
  }
}

test("Cloudflare streams replay committed events, resume by id, and publish thread registration", async () => {
  expect((await SELF.fetch(base, { method: "PUT", headers: authorization })).status).toBe(200)
  const threads = await open("/threads/stream")
  let events: Awaited<ReturnType<typeof open>> | undefined
  let resumed: Awaited<ReturnType<typeof open>> | undefined
  try {
    expect((await threads.next()).event).toEqual({ type: "ThreadsSnapshot", threads: [] })
    expect((await SELF.fetch(`${base}/threads`, {
      method: "POST", headers: { ...authorization, "content-type": "application/json" }, body: JSON.stringify({ name: "root" })
    })).status).toBe(200)
    const registration = await threads.next()
    expect(registration.event).toMatchObject({ type: "ThreadAdded", thread: { id: "root", depth: 0 } })
    events = await open("/threads/root/events/stream")
    const created = await events.next()
    expect(created.event.type).toBe("ThreadCreated")
    expect((await SELF.fetch(`${base}/threads/root/events`, {
      method: "POST", headers: { ...authorization, "content-type": "application/json" }, body: JSON.stringify({ type: "IndexedRecord", secretId: "stream-probe" })
    })).status).toBe(202)
    const live = await events.next()
    expect(live.event.type).toBe("IndexedRecord")
    resumed = await open("/threads/root/events/stream?after=0", { ...authorization, "last-event-id": String(created.seq) })
    expect(await resumed.next()).toEqual(live)
  } finally {
    await events?.close()
    await resumed?.close()
    await threads.close()
  }
})

test("Cloudflare stream routes enforce authorization and reject invalid cursors or unknown threads", async () => {
  for (const path of ["/threads/stream", "/threads/root/events/stream", "/threads/root/inference/stream"]) {
    expect((await SELF.fetch(`${base}${path}`)).status).toBe(401)
    expect((await SELF.fetch(`${base}${path}?after=-1`, { headers: authorization })).status).toBe(400)
  }
  expect((await SELF.fetch(`${base}/threads/missing/events/stream`, { headers: authorization })).status).toBe(404)
  const stub = (env as Env).THREADS.getByName(JSON.stringify(["echo", "stream-test", "unprovisioned"]))
  await stub.init("echo", "stream-test", "unprovisioned")
  expect((await SELF.fetch(`${base}/threads/unprovisioned/events/stream`, { headers: authorization })).status).toBe(404)
})
