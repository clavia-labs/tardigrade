import { SELF, env, evictDurableObject } from "cloudflare:test"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { responseFor, runContract } from "../../../e2e/inference/contract"

let requests = 0
beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    if (new URL(request.url).hostname !== "provider.test") throw new Error(`Unexpected provider request: ${request.url}`)
    requests++
    const body = await request.text()
    if (body.includes('"retry"') && request.headers.get("idempotency-key") === "m1/infer/0") return new Response(JSON.stringify({ error: { message: "busy", type: "rate_limit_error" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } })
    return new Response(responseFor(body), { headers: { "content-type": "text/event-stream" } })
  })
})
afterAll(() => vi.restoreAllMocks())
for (const scenario of ["complete", "broken", "retry"] as const) test(`workerd HTTP inference: ${scenario}`, async () => {
  const before = requests
  const runtimeFetch = (path: string, init?: RequestInit) => SELF.fetch(`http://test${path}`, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: "Bearer fixture" } })
  const result = await runContract(runtimeFetch, scenario)
  const threads = (env as { THREADS: DurableObjectNamespace }).THREADS
  await evictDurableObject(threads.getByName(JSON.stringify(["inference-test", "main", scenario])))
  expect(await (await runtimeFetch(result.path)).json()).toEqual(result.state)
  expect(requests - before).toBe(scenario === "retry" ? 3 : 2)
})
