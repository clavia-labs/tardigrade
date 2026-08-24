import { env, runInDurableObject, SELF } from "cloudflare:test"
import { Effect, ManagedRuntime } from "effect"
import { describe, expect, test } from "vitest"
import type { ModelCatalog } from "@clavia/tardigrade-client/contract"
import { ModelCatalogRepository } from "@clavia/tardigrade-server/catalog-store"
import type { Env } from "../src/worker"
import { layerCloudflareModelCatalogRepository } from "../src/catalog"
import { CloudflareActorRegistry, layerCloudflareActorRegistry } from "../src/registry"

const authorization = { authorization: "Bearer workers-test-token" }
const actorStub = () => (env as Env).ACTORS.getByName("echo")
const alarm = () => runInDurableObject(actorStub(), (_instance, state) => state.storage.getAlarm())

const methodState = async (): Promise<unknown> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await SELF.fetch("http://test/v1/actors/echo/threads/root/methods/echo/calls/workers-smoke", {
      headers: authorization
    })
    const state = await response.json() as { readonly status?: unknown }
    if (state.status === "completed") return state
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return undefined
}

describe("cloudflare actor", () => {
  test("D1 persists model catalog snapshots", async () => {
    const runtime = ManagedRuntime.make(layerCloudflareModelCatalogRepository((env as Env).REGISTRY))
    const snapshot: ModelCatalog = {
      source: "models.dev",
      revision: "workers-catalog-test",
      refreshedAt: 1,
      status: "fresh",
      providers: [{
        id: "openai",
        name: "OpenAI",
        env: ["OPENAI_API_KEY"],
        models: [{ id: "gpt-test", metadata: { contextWindowTokens: 128_000 } }]
      }]
    }
    try {
      const repository = await runtime.runPromise(ModelCatalogRepository)
      await Effect.runPromise(repository.write("https://models.test/catalog.json", snapshot))
      expect(await Effect.runPromise(repository.read("https://models.test/catalog.json"))).toEqual({
        ...snapshot,
        status: "cached"
      })
      expect(await Effect.runPromise(repository.read("https://other.test/catalog.json"))).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  })

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

  test("a mounted actor exposes durable methods", async () => {
    const refused = await SELF.fetch("http://test/v1/actors")
    expect(refused.status).toBe(401)
    const actors = await SELF.fetch("http://test/v1/actors", { headers: authorization })
    expect(await actors.json()).toEqual([{ name: "echo", builtIn: true }])
    const missing = await SELF.fetch("http://test/v1/actors/missing/threads", { headers: authorization })
    expect(missing.status).toBe(404)
    const methods = await SELF.fetch("http://test/v1/actors/echo/methods", { headers: authorization })
    expect(await methods.json()).toEqual([expect.objectContaining({
      name: "echo",
      inputSchema: expect.objectContaining({ type: "object" }),
      outputSchema: expect.objectContaining({ type: "string" })
    })])
    const accepted = await SELF.fetch("http://test/v1/actors/echo/threads/root/methods/echo/calls/workers-smoke", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ text: "Run in workerd." })
    })
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toEqual({ actor: "echo", thread: "root", method: "echo", call: "workers-smoke" })
    expect(await alarm()).not.toBeNull()
    expect(await methodState()).toEqual({ status: "completed", output: "Run in workerd." })
    expect(await alarm()).toBeNull()
    const redelivered = await SELF.fetch("http://test/v1/actors/echo/threads/root/methods/echo/calls/workers-smoke", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ text: "Run in workerd." })
    })
    expect(redelivered.status).toBe(202)
    const events = await SELF.fetch("http://test/v1/actors/echo/threads/root/events", { headers: authorization })
    expect((await events.json() as ReadonlyArray<{ readonly event: { readonly type: string } }>).map((row) => row.event.type)).toEqual([
      "ThreadCreated",
      "EchoRequested",
      "EchoCompleted"
    ])
    const health = await SELF.fetch("http://test/healthz")
    expect(await health.json()).toEqual({ status: "resting", dirty: 0 })
  })
})
