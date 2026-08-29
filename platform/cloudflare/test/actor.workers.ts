import { env, runInDurableObject, SELF } from "cloudflare:test"
import { Effect, ManagedRuntime } from "effect"
import { describe, expect, test } from "vitest"
import { makeActorClient } from "@clavia/tardigrade-client"
import type { ModelCatalog } from "@clavia/tardigrade-client/contract"
import { ModelCatalogRepository } from "@clavia/tardigrade-server/catalog-store"
import type { Env } from "../src/worker"
import { layerCloudflareModelCatalogRepository } from "../src/catalog"

const authorization = { authorization: "Bearer workers-test-token" }
const threadObjectNameOf = (thread: string): string => JSON.stringify(["echo", `ag.${thread}`])
const controlStub = () => (env as Env).ACTORS.getByName("echo")
const threadStub = (thread: string) => (env as Env).THREADS.getByName(threadObjectNameOf(thread))
const alarm = (thread: string) =>
  runInDurableObject(threadStub(thread), (_instance, state) => state.storage.getAlarm())

const methodState = async (thread: string, call: string): Promise<unknown> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await SELF.fetch(`http://test/v1/threads/${thread}/methods/echo/calls/${call}`, {
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
    await runInDurableObject(controlStub(), async (_instance, state) => {
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
    const refused = await SELF.fetch("http://test/v1/methods")
    expect(refused.status).toBe(401)
    const methods = await SELF.fetch("http://test/v1/methods", { headers: authorization })
    expect(await methods.json()).toEqual([expect.objectContaining({
      name: "echo",
      inputSchema: expect.objectContaining({ type: "object" }),
      outputSchema: expect.objectContaining({ type: "string" })
    })])
    const accepted = await SELF.fetch("http://test/v1/threads/root/methods/echo/calls/workers-smoke", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ text: "Run in workerd." })
    })
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toEqual({ thread: "root", method: "echo", call: "workers-smoke" })
    expect(await alarm("root")).not.toBeNull()
    expect(await methodState("root", "workers-smoke")).toEqual({ status: "completed", output: "workers:ag.root:1:Run in workerd." })
    expect(await alarm("root")).toBeNull()
    const client = makeActorClient({
      baseUrl: "http://test",
      token: "workers-test-token",
      fetch: (input, init) => SELF.fetch(input, init)
    })
    expect(await client.invoke("root", "echo", { id: "workers-smoke", input: { text: "Run in workerd." } }))
      .toEqual({ thread: "root", method: "echo", call: "workers-smoke" })
    expect(await client.methodState("root", "echo", "workers-smoke"))
      .toEqual({ status: "completed", output: "workers:ag.root:1:Run in workerd." })
    const events = await SELF.fetch("http://test/v1/threads/root/events", { headers: authorization })
    expect((await events.json() as ReadonlyArray<{ readonly event: { readonly type: string } }>).map((row) => row.event.type)).toEqual([
      "ThreadCreated",
      "EchoRequested",
      "EchoCompleted"
    ])
    const health = await SELF.fetch("http://test/healthz")
    expect(await health.json()).toEqual({ status: "ready", actor: "echo" })
    const threads = await SELF.fetch("http://test/v1/threads", { headers: authorization })
    expect(threads.status).toBe(200)
    expect(await threads.json()).toEqual([expect.objectContaining({ id: "root" })])
    expect(await client.methods()).toEqual([expect.objectContaining({ name: "echo" })])
    expect(await client.metadata()).toEqual({ name: "echo", storage: { kind: "durable-object" } })
  })

  test("a mounted actor receives thread application services", async () => {
    const invoke = async (thread: string, call: string, text: string) => {
      const accepted = await SELF.fetch(`http://test/v1/threads/${thread}/methods/echo/calls/${call}`, {
        method: "PUT",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify({ text })
      })
      expect(accepted.status).toBe(202)
      return methodState(thread, call)
    }
    const [first, second] = await Promise.all([
      invoke("application-a", "application-a", "first"),
      invoke("application-b", "application-b", "second")
    ])
    expect(first).toEqual({ status: "completed", output: "workers:ag.application-a:1:first" })
    expect(second).toEqual({ status: "completed", output: "workers:ag.application-b:1:second" })
    expect(threadStub("application-a").id.equals(threadStub("application-b").id)).toBe(false)
    const firstEvents = await runInDurableObject(threadStub("application-a"), (_instance, state) =>
      state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM events").toArray()
    )
    const secondEvents = await runInDurableObject(threadStub("application-b"), (_instance, state) =>
      state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM events").toArray()
    )
    expect(firstEvents[0]?.count).toBeGreaterThan(0)
    expect(secondEvents[0]?.count).toBeGreaterThan(0)
    const migrations = await runInDurableObject(threadStub("application-a"), (_instance, state) => ({
      tables: state.storage.sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'"
      ).toArray().map((row) => row.name),
      entries: state.storage.sql.exec<{ migration_id: number; name: string }>(
        "SELECT migration_id, name FROM effect_sql_migrations"
      ).toArray()
    }))
    expect(migrations).toEqual({
      tables: ["effect_sql_migrations"],
      entries: [
        { migration_id: 1, name: "thread_identity" },
        { migration_id: 2, name: "thread_events" }
      ]
    })
  })

  test("a thread store wrapper covers method ingress, reactors, and API reads", async () => {
    const prompt = "classified prompt"
    const accepted = await SELF.fetch("http://test/v1/threads/sealed/methods/echo/calls/sealed-call", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ text: prompt })
    })
    expect(accepted.status).toBe(202)
    expect(await methodState("sealed", "sealed-call")).toEqual({
      status: "completed",
      output: "workers:ag.sealed:1:classified prompt"
    })

    const response = await SELF.fetch("http://test/v1/threads/sealed/events", { headers: authorization })
    const visible = await response.json() as ReadonlyArray<{ readonly event: { readonly type: string; readonly text?: string } }>
    expect(visible.map((row) => row.event.type)).toEqual(["ThreadCreated", "EchoRequested", "EchoCompleted"])
    expect(visible.some((row) => row.event.text?.includes(prompt))).toBe(true)

    const raw = await runInDurableObject(threadStub("sealed"), (_instance, state) =>
      state.storage.sql.exec<{ readonly event: string }>("SELECT event FROM events ORDER BY seq").toArray()
    )
    expect(raw).toHaveLength(3)
    expect(raw.every((row) => {
      const encrypted = JSON.parse(row.event) as { readonly iv?: unknown; readonly ciphertext?: unknown }
      return typeof encrypted.iv === "string" && typeof encrypted.ciphertext === "string"
    })).toBe(true)
    expect(raw.every((row) => !row.event.includes(prompt))).toBe(true)
  })

  test("actor directory registration keeps child lineage", async () => {
    const directory = controlStub()
    await directory.init("echo")
    await directory.registerThread("ag.directory-child", {
      parent: { actor: "echo", thread: "ag.directory-parent" },
      depth: 1,
      placement: "independent"
    })
    await directory.registerThread("ag.directory-child")
    const entries = await runInDurableObject(directory, (_instance, state) =>
      state.storage.sql.exec<{
        thread: string
        parent_thread: string | null
        depth: number
        placement: string | null
      }>("SELECT thread, parent_thread, depth, placement FROM thread_directory WHERE thread = 'ag.directory-child'").toArray()
    )
    expect(entries).toEqual([{
      thread: "ag.directory-child",
      parent_thread: "ag.directory-parent",
      depth: 1,
      placement: "independent"
    }])
  })

  test("a durable object alarm terminates an overdue method call", async () => {
    const deadlineAt = Date.now() - 1
    const stub = threadStub("timeout")
    await stub.init("echo", "ag.timeout")
    await stub.append("timeout", {
      type: "CallDispatched",
      id: "overdue-1",
      method: "inspect",
      target: "remote:shared",
      input: {},
      timeoutMs: 10,
      deadlineAt,
      at: deadlineAt - 10
    })

    let events = await stub.events("timeout")
    for (let attempt = 0; attempt < 100 && !events.some((event) => event.type === "CallTimedOut"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      events = await stub.events("timeout")
    }

    expect(events).toContainEqual(expect.objectContaining({
      type: "AlarmFired",
      scheduledFor: deadlineAt
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: "CallTimedOut",
      call: "overdue-1",
      deadlineAt
    }))
    expect(await alarm("timeout")).toBeNull()
  })
})
