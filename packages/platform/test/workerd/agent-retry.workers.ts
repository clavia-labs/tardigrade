import { SELF } from "cloudflare:test"
import { test, expect } from "vitest"
import { retryCallCount } from "./agent-fixture.worker"

test("a provider retry hint reaches the effect runtime through the agent adapter", async () => {
  const base = "http://test/v1/actors/retry-transient/threads"
  expect((await SELF.fetch(base, { method: "POST", body: JSON.stringify({ name: "thread" }) })).status).toBe(200)
  const method = `${base}/thread/methods/message`
  expect((await SELF.fetch(method, { method: "POST", headers: { "idempotency-key": "message" }, body: JSON.stringify({ text: "hello" }) })).status).toBe(202)
  await expect.poll(async () => (await SELF.fetch(`${method}/calls/message`)).json()).toMatchObject({ status: "completed", output: { text: "ok" } })
  expect(retryCallCount()).toBe(2)
})
