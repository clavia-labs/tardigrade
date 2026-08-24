import { env, SELF } from "cloudflare:test"
import { Effect, ManagedRuntime } from "effect"
import { describe, expect, test } from "vitest"
import type { Env } from "../src/worker"
import { CloudflareActorRegistry, layerCloudflareActorRegistry } from "../src/registry"

const authorization = { authorization: "Bearer workers-test-token" }

const trajectory = async (): Promise<ReadonlyArray<{ readonly seq: number; readonly event: { readonly type: string } }>> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await SELF.fetch("http://test/v1/actors/default/threads/root/events", { headers: authorization })
    const body = await response.text()
    if (!response.ok) throw new Error(`event read returned ${response.status}: ${body}`)
    const events = JSON.parse(body) as ReadonlyArray<{ readonly seq: number; readonly event: { readonly type: string } }>
    if (events.some((row) => row.event.type === "TurnFailed")) return events
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return []
}

describe("cloudflare actor", () => {
  test("D1 persists actor registry replacements and removals", async () => {
    const runtime = ManagedRuntime.make(layerCloudflareActorRegistry((env as Env).REGISTRY))
    try {
      const registry = await runtime.runPromise(CloudflareActorRegistry)
      await Effect.runPromise(registry.put({
        name: "workers-registry-test",
        assembly: "default",
        host: "workers-registry-test",
        builtIn: false,
        digest: "one"
      }))
      await Effect.runPromise(registry.put({
        name: "workers-registry-test",
        assembly: "default",
        host: "workers-registry-test",
        builtIn: false,
        digest: "two"
      }))
      expect(await Effect.runPromise(registry.resolve("workers-registry-test"))).toMatchObject({ digest: "two" })
      expect((await Effect.runPromise(registry.list)).map((registration) => registration.name)).toContain("workers-registry-test")
      await Effect.runPromise(registry.remove("workers-registry-test"))
      await Effect.runPromise(registry.remove("workers-registry-test"))
      expect(await Effect.runPromise(registry.resolve("workers-registry-test"))).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  })

  test("an alarm settles a durable root message", async () => {
    const refused = await SELF.fetch("http://test/v1/actors")
    expect(refused.status).toBe(401)
    const actors = await SELF.fetch("http://test/v1/actors", { headers: authorization })
    expect(await actors.json()).toEqual([{ name: "default", builtIn: true }])
    const missing = await SELF.fetch("http://test/v1/actors/missing/threads", { headers: authorization })
    expect(missing.status).toBe(404)
    const accepted = await SELF.fetch("http://test/v1/actors/default/threads/root/events", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ type: "MessageReceived", id: "workers-smoke", text: "Run in workerd." })
    })
    expect(accepted.status).toBe(202)
    const events = await trajectory()
    expect(events.map((row) => row.event.type)).toEqual([
      "ThreadCreated",
      "MessageReceived",
      "ModelResolved",
      "ModelCalled",
      "TurnFailed",
      "ReplyDelivered"
    ])
    const redelivered = await SELF.fetch("http://test/v1/actors/default/threads/root/events", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ type: "MessageReceived", id: "workers-smoke", text: "Run in workerd." })
    })
    expect(redelivered.status).toBe(202)
    expect((await trajectory()).map((row) => row.event.type)).toEqual(events.map((row) => row.event.type))
    const health = await SELF.fetch("http://test/healthz")
    expect(await health.json()).toEqual({ status: "resting", dirty: 0 })
  })
})
