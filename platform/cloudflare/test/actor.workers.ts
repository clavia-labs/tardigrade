import { env, runInDurableObject, SELF } from "cloudflare:test"
import { Effect, ManagedRuntime } from "effect"
import { describe, expect, test } from "vitest"
import { makeClient } from "@clavia/tardigrade-client"
import type { ModelCatalog } from "@clavia/tardigrade-client/contract"
import { ModelCatalogRepository } from "@clavia/tardigrade-server/catalog-store"
import type { Env } from "../src/worker"
import { layerCloudflareModelCatalogRepository } from "../src/catalog"

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
  test("actor storage persists model catalog snapshots", async () => {
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
    await runInDurableObject(actorStub(), async (_instance, state) => {
      const runtime = ManagedRuntime.make(layerCloudflareModelCatalogRepository(state.storage))
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
    const providers = await SELF.fetch("http://test/v1/providers?search=open&limit=1")
    expect(providers.status).toBe(200)
    expect(await providers.json()).toEqual(expect.objectContaining({
      total: 2,
      items: [expect.objectContaining({ id: "openai" })]
    }))
  })

  test("a mounted actor exposes durable methods", async () => {
    const refused = await SELF.fetch("http://test/v1/actors/echo/methods")
    expect(refused.status).toBe(401)
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
    const client = makeClient({
      baseUrl: "http://test",
      actor: "echo",
      token: "workers-test-token",
      fetch: (input, init) => SELF.fetch(input, init)
    })
    expect(await client.invoke("root", "echo", { id: "workers-smoke", input: { text: "Run in workerd." } }))
      .toEqual({ actor: "echo", thread: "root", method: "echo", call: "workers-smoke" })
    expect(await client.methodState("root", "echo", "workers-smoke"))
      .toEqual({ status: "completed", output: "Run in workerd." })
    const events = await SELF.fetch("http://test/v1/actors/echo/threads/root/events", { headers: authorization })
    expect((await events.json() as ReadonlyArray<{ readonly event: { readonly type: string } }>).map((row) => row.event.type)).toEqual([
      "ThreadCreated",
      "EchoRequested",
      "EchoCompleted"
    ])
    const health = await SELF.fetch("http://test/healthz")
    expect(await health.json()).toEqual({ status: "resting", dirty: 0 })
    const threads = await SELF.fetch("http://test/v1/actors/echo/threads", { headers: authorization })
    expect(await threads.json()).toEqual([expect.objectContaining({ id: "root", depth: 0, events: 3, status: "settled" })])
    expect(await client.methods()).toEqual([expect.objectContaining({ name: "echo" })])
    expect(await client.list()).toEqual([expect.objectContaining({ id: "root", status: "settled" })])
    const unknown = await SELF.fetch("http://test/v1/actors/missing/methods", { headers: authorization })
    expect(unknown.status).toBe(404)
  })
})
