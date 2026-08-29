import { env, runInDurableObject, SELF } from "cloudflare:test"
import { Effect, ManagedRuntime } from "effect"
import { describe, expect, test } from "vitest"
import { makeActorClient } from "@clavia/tardigrade-client"
import type { ModelCatalog } from "@clavia/tardigrade-client/contract"
import { ModelCatalogRepository } from "@clavia/tardigrade-server/catalog-store"
import { actorFromReactors } from "@clavia/tardigrade-core/reconciliation"
import {
  backgroundTaskOwnerOf,
  DEFAULT_BACKGROUND_TASK_OWNER,
  retainBackgroundTask,
  type Env
} from "../src/worker"
import { layerCloudflareModelCatalogRepository } from "../src/catalog"
import { createCloudflareThreadHost } from "../src/host"

const authorization = { authorization: "Bearer workers-test-token" }
const WORKER_INTEGRATION_TIMEOUT_MILLIS = 15_000
const threadObjectNameOf = (thread: string): string => JSON.stringify(["echo", "main", `ag.${thread}`])
const controlStub = () => (env as Env).ACTORS.getByName(JSON.stringify(["echo", "main"]))
const catalogStub = () => (env as Env).ACTORS.getByName(JSON.stringify(["echo", "$catalog"]))
const threadStub = (thread: string) => (env as Env).THREADS.getByName(threadObjectNameOf(thread))
const alarm = (thread: string) =>
  runInDurableObject(threadStub(thread), (_instance, state) => state.storage.getAlarm())

const createThread = async (thread: string): Promise<void> => {
  const actor = await SELF.fetch("http://test/v1/actors/main", { method: "PUT", headers: authorization })
  expect(actor.status).toBe(200)
  const created = await SELF.fetch(`http://test/v1/actors/main/threads/${thread}`, { method: "PUT", headers: authorization })
  expect(created.status).toBe(200)
  expect(await created.json()).toEqual({ actor: "main", thread })
}

const methodState = async (thread: string, call: string): Promise<unknown> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await SELF.fetch(`http://test/v1/actors/main/threads/${thread}/methods/echo/calls/${call}`, {
      headers: authorization
    })
    const state = await response.json() as { readonly status?: unknown }
    if (state.status === "completed") return state
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return undefined
}

describe("cloudflare actor", () => {
  test("commit observers see only published durable heads", async () => {
    const commits = await runInDurableObject(threadStub("commit-observer"), async (_instance, state) => {
      const seen: Array<number> = []
      let observed = () => {}
      const firstObserved = new Promise<void>((resolve) => { observed = resolve })
      const host = await createCloudflareThreadHost({
        storage: state.storage,
        actorName: "echo",
        actorInstance: "main",
        thread: "ag.commit-observer",
        actor: actorFromReactors([]),
        commitObserver: {
          onCommit: ({ head }) => Effect.sync(() => {
            seen.push(head)
            if (head === 2) observed()
          })
        },
        retainCommitTask: (task) => state.waitUntil(task)
      })

      await host.commitRoot({ type: "MessageReceived", id: "first", at: 1 })
      await firstObserved
      await host.stageRoot({ type: "MessageReceived", id: "second", at: 2 })
      await state.storage.sync()
      expect(seen).toEqual([2])
      host.publishStaged()
      await host.close()
      return seen
    })

    expect(commits).toEqual([2, 3])
  })

  test("background tasks belong to the configured owner", () => {
    expect(backgroundTaskOwnerOf(undefined)).toBe(DEFAULT_BACKGROUND_TASK_OWNER)
    expect(backgroundTaskOwnerOf("request", "host")).toBe("request")
    expect(() => backgroundTaskOwnerOf("detached")).toThrow("must be \"host\" or \"request\"")
    const retained: Array<Promise<unknown>> = []
    const task = Promise.resolve()
    const scope = { waitUntil: (value: Promise<unknown>) => retained.push(value) }
    retainBackgroundTask(scope, "host", task)
    retainBackgroundTask(scope, "request", task)
    expect(retained).toEqual([task])
  })

  test("an ambiguous actor instance id is refused", async () => {
    const invalidActor = await SELF.fetch("http://test/v1/actors/tenant%3Awest", {
      method: "PUT",
      headers: authorization
    })
    expect(invalidActor.status).toBe(400)
  })

  test("actor instance path parameters are decoded once", async () => {
    const response = await SELF.fetch("http://test/v1/actors/tenant%252Fwest", {
      method: "PUT",
      headers: authorization
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ actor: "tenant%2Fwest", definition: "echo" })
  })

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
    await runInDurableObject(catalogStub(), async (_instance, state) => {
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
    const missing = await SELF.fetch("http://test/v1/actors/main/threads/root/methods/echo/calls/workers-smoke", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ text: "Run in workerd." })
    })
    expect(missing.status).toBe(404)
    await createThread("root")
    const accepted = await SELF.fetch("http://test/v1/actors/main/threads/root/methods/echo/calls/workers-smoke", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ text: "Run in workerd." })
    })
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toEqual({ actor: "main", thread: "root", method: "echo", call: "workers-smoke" })
    expect(await methodState("root", "workers-smoke")).toEqual({ status: "completed", output: "workers:ag.root:1:Run in workerd." })
    expect(await alarm("root")).toBeNull()
    const client = makeActorClient({
      baseUrl: "http://test",
      token: "workers-test-token",
      fetch: (input, init) => SELF.fetch(input, init)
    })
    expect(await client.invoke("main", "root", "echo", { id: "workers-smoke", input: { text: "Run in workerd." } }))
      .toEqual({ actor: "main", thread: "root", method: "echo", call: "workers-smoke" })
    expect(await client.methodState("main", "root", "echo", "workers-smoke"))
      .toEqual({ status: "completed", output: "workers:ag.root:1:Run in workerd." })
    const events = await SELF.fetch("http://test/v1/actors/main/threads/root/events", { headers: authorization })
    expect((await events.json() as ReadonlyArray<{ readonly event: { readonly type: string } }>).map((row) => row.event.type)).toEqual([
      "ThreadCreated",
      "EchoRequested",
      "EchoCompleted"
    ])
    const health = await SELF.fetch("http://test/healthz")
    expect(await health.json()).toEqual({ status: "ready", actor: "echo" })
    const threads = await SELF.fetch("http://test/v1/actors/main/threads", { headers: authorization })
    expect(threads.status).toBe(200)
    expect(await threads.json()).toEqual([{ id: "root", depth: 0, children: [] }])
    expect(await client.methods()).toEqual([expect.objectContaining({ name: "echo" })])
    expect(await client.metadata()).toEqual({ name: "echo", storage: { kind: "durable-object" } })
  }, WORKER_INTEGRATION_TIMEOUT_MILLIS)

  test("a mounted actor receives thread application services", async () => {
    const invoke = async (thread: string, call: string, text: string) => {
      await createThread(thread)
      const accepted = await SELF.fetch(`http://test/v1/actors/main/threads/${thread}/methods/echo/calls/${call}`, {
        method: "PUT",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify({ text })
      })
      expect(accepted.status).toBe(202)
    }
    await Promise.all([
      invoke("application-a", "application-a", "first"),
      invoke("application-b", "application-b", "second")
    ])
    const first = await methodState("application-a", "application-a")
    const second = await methodState("application-b", "application-b")
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
  }, WORKER_INTEGRATION_TIMEOUT_MILLIS)

  test("a thread event codec covers method ingress, reactors, and API reads", async () => {
    const prompt = "classified prompt"
    await createThread("sealed")
    const accepted = await SELF.fetch("http://test/v1/actors/main/threads/sealed/methods/echo/calls/sealed-call", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ text: prompt })
    })
    expect(accepted.status).toBe(202)
    expect(await methodState("sealed", "sealed-call")).toEqual({
      status: "completed",
      output: "workers:ag.sealed:1:classified prompt"
    })
    const repeated = await SELF.fetch("http://test/v1/actors/main/threads/sealed/methods/echo/calls/sealed-call", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ text: prompt })
    })
    expect(repeated.status).toBe(202)
    expect(await methodState("sealed", "sealed-call")).toEqual({
      status: "completed",
      output: "workers:ag.sealed:1:classified prompt"
    })

    const response = await SELF.fetch("http://test/v1/actors/main/threads/sealed/events", { headers: authorization })
    const visible = await response.json() as ReadonlyArray<{ readonly event: { readonly type: string; readonly text?: string } }>
    expect(visible.map((row) => row.event.type)).toEqual(["ThreadCreated", "EchoRequested", "EchoCompleted"])
    expect(visible.some((row) => row.event.text?.includes(prompt))).toBe(true)

    const filtered = await SELF.fetch(
      "http://test/v1/actors/main/threads/sealed/events?after=0&limit=1&types=EchoCompleted",
      { headers: authorization }
    )
    expect(await filtered.json()).toEqual([{
      seq: 3,
      event: expect.objectContaining({ type: "EchoCompleted", text: expect.stringContaining(prompt) })
    }])
    const idle = await SELF.fetch(
      "http://test/v1/actors/main/threads/sealed/events?after=3&limit=1",
      { headers: authorization }
    )
    expect(await idle.json()).toEqual([])

    const raw = await runInDurableObject(threadStub("sealed"), (_instance, state) =>
      state.storage.sql.exec<{ readonly key: string | null; readonly event: string }>("SELECT key, event FROM events ORDER BY seq").toArray()
    )
    expect(raw).toHaveLength(3)
    expect(raw.every((row) => {
      const encrypted = JSON.parse(row.event) as { readonly iv?: unknown; readonly ciphertext?: unknown }
      return typeof encrypted.iv === "string" && typeof encrypted.ciphertext === "string"
    })).toBe(true)
    expect(raw.every((row) => !row.event.includes(prompt))).toBe(true)
    expect(raw.every((row) => row.key === null || /^hmac-sha256:[a-f0-9]{64}$/.test(row.key))).toBe(true)
    expect(raw.every((row) => !row.key?.includes("sealed-call"))).toBe(true)

    for (const secretId of ["first-secret", "second-secret"]) {
      const appended = await SELF.fetch("http://test/v1/actors/main/threads/sealed/events", {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify({ type: "IndexedRecord", secretId })
      })
      expect(appended.status).toBe(202)
    }
    const indexed = await SELF.fetch(
      "http://test/v1/actors/main/threads/sealed/events?after=0&limit=10&types=IndexedRecord",
      { headers: authorization }
    )
    expect((await indexed.json() as ReadonlyArray<{ readonly event: { readonly secretId: string } }>).map((row) => row.event.secretId))
      .toEqual(["first-secret", "second-secret"])
  })

  test("actor supervisor creates a child after durable acceptance", async () => {
    const directory = controlStub()
    await directory.init("echo", "main")
    await directory.createThread("ag.directory-parent")
    const parent = { actor: "echo", instance: "main", thread: "ag.directory-parent" }
    const target = { actor: "echo", instance: "main", thread: "ag.directory-child" }
    const lineage = {
      parent,
      depth: 1,
      placement: "independent" as const
    }
    const requested = await runInDurableObject(directory, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO events (seq, key, event)
         VALUES (
           (SELECT COALESCE(MAX(seq), 0) + 1 FROM events),
           'thread:requested:ag.directory-child',
           '{"type":"ThreadRequested","thread":"ag.directory-child","parentThread":"ag.directory-parent","depth":1,"placement":"independent","at":1}'
         )`
      )
      return state.storage.sql.exec<{
        key: string
        event: string
      }>("SELECT key, event FROM events WHERE key = 'thread:requested:ag.directory-child'").toArray()
    })
    expect(requested).toEqual([{ key: "thread:requested:ag.directory-child", event: expect.stringContaining('"type":"ThreadRequested"') }])
    const requestedTree = await directory.threadTree()
    expect(requestedTree.find((node) => node.id === "directory-parent")).toEqual({
      id: "directory-parent",
      depth: 0,
      children: []
    })
    expect(requestedTree.some((node) => node.id === "directory-child")).toBe(false)
    await directory.deliverChild({
      link: { source: parent, target },
      event: { type: "MessageReceived", id: "directory-child-message", text: "hello", at: 2 },
      lineage
    })
    const fresh = { actor: "echo", instance: "main", thread: "ag.directory-fresh" }
    await directory.deliverChild({
      link: { source: parent, target: fresh },
      event: { type: "MessageReceived", id: "directory-fresh-message", text: "hello", at: 3 },
      lineage
    })
    const tree = await directory.threadTree()
    expect(tree.find((node) => node.id === "directory-parent")).toEqual({
      id: "directory-parent",
      depth: 0,
      children: [{
        id: "directory-child",
        parent: "directory-parent",
        depth: 1,
        placement: "independent",
        children: []
      }, {
        id: "directory-fresh",
        parent: "directory-parent",
        depth: 1,
        placement: "independent",
        children: []
      }]
    })
    const childEvents = await threadStub("directory-child").events("directory-child")
    expect(childEvents.map((event) => event.type)).toEqual(["ThreadCreated", "MessageReceived"])
    const lifecycle = await runInDurableObject(directory, (_instance, state) =>
      state.storage.sql.exec<{ event: string }>("SELECT event FROM events ORDER BY seq").toArray()
    )
    expect(lifecycle
      .map((row) => JSON.parse(row.event) as { readonly type: string; readonly thread: string })
      .filter((event) => event.thread.startsWith("ag.directory-"))
      .map((event) => event.type)).toEqual([
      "ThreadRequested",
      "ThreadCreated",
      "ThreadRequested",
      "ThreadCreated",
      "ThreadRequested",
      "ThreadCreated"
    ])
  })

  test("actor supervisor alarm completes a staged child", async () => {
    const directory = controlStub()
    await directory.init("echo", "main")
    await directory.createThread("ag.recovery-parent")
    const parent = { actor: "echo", instance: "main", thread: "ag.recovery-parent" }
    const target = { actor: "echo", instance: "main", thread: "ag.recovery-child" }
    const lineage = { parent, depth: 1, placement: "independent" as const }
    const child = threadStub("recovery-child")
    await child.init("echo", "main", "ag.recovery-child")
    await child.stageCreation({
      link: { source: parent, target },
      event: { type: "MessageReceived", id: "recovery-message", text: "hello", at: 4 },
      lineage
    })
    await runInDurableObject(directory, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO events (seq, key, event)
         VALUES (
           (SELECT COALESCE(MAX(seq), 0) + 1 FROM events),
           'thread:requested:ag.recovery-child',
           '{"type":"ThreadRequested","thread":"ag.recovery-child","parentThread":"ag.recovery-parent","depth":1,"placement":"independent","at":4}'
         )`
      )
    })
    expect((await directory.threadTree()).some((node) => node.id === "recovery-child")).toBe(false)
    await runInDurableObject(directory, (instance) => instance.alarm())
    expect((await directory.threadTree()).find((node) => node.id === "recovery-parent")).toEqual({
      id: "recovery-parent",
      depth: 0,
      children: [{
        id: "recovery-child",
        parent: "recovery-parent",
        depth: 1,
        placement: "independent",
        children: []
      }]
    })
  })

  test("a durable object alarm terminates an overdue method call", async () => {
    const deadlineAt = Date.now() - 1
    const stub = threadStub("timeout")
    await createThread("timeout")
    await stub.append("timeout", {
      type: "CallDispatched",
      id: "overdue-1",
      method: "inspect",
      target: "remote:main:shared",
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
