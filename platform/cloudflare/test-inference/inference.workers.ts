import { SELF, env, evictDurableObject } from "cloudflare:test"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { responseFor, runContract } from "../../../e2e/inference/contract"

let requests = 0
beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    if (new URL(request.url).hostname !== "provider.test") throw new Error(`Unexpected provider request: ${request.url}`)
    requests++
    return new Response(responseFor(await request.text()), { headers: { "content-type": "text/event-stream" } })
  })
})
afterAll(() => vi.restoreAllMocks())
for (const scenario of ["complete", "broken"] as const) test(`workerd HTTP inference: ${scenario}`, async () => {
  const before = requests
  const runtimeFetch = (path: string, init?: RequestInit) => SELF.fetch(`http://test${path}`, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: "Bearer fixture" } })
  const result = await runContract(runtimeFetch, scenario)
  const threads = (env as { THREADS: DurableObjectNamespace }).THREADS
  await evictDurableObject(threads.getByName(JSON.stringify(["inference-test", "main", scenario])))
  expect(await (await runtimeFetch(result.path)).json()).toEqual(result.state)
  expect(requests - before).toBe(scenario === "complete" ? 2 : 1)
})
