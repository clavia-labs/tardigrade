import { modelLockService } from "@clavia/tardigrade-model/lock"
import { upgradeModelLock } from "@clavia/tardigrade-model/lock-compat"
import { ModelLock } from "@clavia/tardigrade-model/lock"
import { threadSupervisor } from "@clavia/tardigrade-core/actor/supervisor"
import { childKeyOf } from "@clavia/tardigrade-core/actor/coordinate"
import { threadCreated } from "@clavia/tardigrade-core/interaction/relations"
import { env, runInDurableObject, evictDurableObject, SELF } from "cloudflare:test"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { actor, actorMethod, component } from "@clavia/tardigrade-core/actor"

import type { Event } from "@clavia/tardigrade-core/event"
import { beforeAll, describe, expect, test } from "vitest"
import { makeActorClient } from "@clavia/tardigrade-client"
import type { ModelCatalog } from "@clavia/tardigrade-client/contract"
import { ModelCatalogRepository } from "@clavia/tardigrade-model/catalog/repository"
import { actorFromProjections, actorRuntimeOf } from "@clavia/tardigrade-core/runtime"
import { deadlineCancellationEventsAt } from "@clavia/tardigrade-core/interaction/timeout"
import {
  createWorker,
  workerModelServices,
  cloudflareWorker,
  backgroundTaskOwnerOf,
  DEFAULT_BACKGROUND_TASK_OWNER,
  modelCatalogForConfig,
  modelScopeFrom,
  retainBackgroundTask,
  type ActorThreadNode,
  type Env
} from "../src/worker"
import { providerLayer } from "@clavia/tardigrade-model/providers/openai-compat"
import { ModelSelection } from "@clavia/tardigrade-model/settings"
import { modelLayer, modelsFrom, mountedActor, modelConfigFrom, modelStateFrom, publicCatalog } from "../src/assembly"
import { layerCloudflareModelCatalogRepository } from "../src/catalog"
import { createCloudflareThreadHost } from "../src/host"
import { plaintextEventCodec } from "../src/storage"

const authorization = { authorization: "Bearer workers-test-token" }
const WORKER_INTEGRATION_TIMEOUT_MILLIS = 15_000
const threadObjectNameOf = (thread: string): string => JSON.stringify(["echo", "main", thread])
const controlStub = () => (env as Env).ACTORS.getByName(JSON.stringify(["echo", "main"]))
const threadStub = (thread: string) => (env as Env).THREADS.getByName(threadObjectNameOf(thread))
const alarm = (thread: string) =>
  runInDurableObject(threadStub(thread), (_instance, state) => state.storage.getAlarm())

const createThread = async (thread: string): Promise<void> => {
  const actor = await SELF.fetch("http://test/v1/actors/main", { method: "PUT", headers: authorization })
  expect(actor.status).toBe(200)
  const created = await SELF.fetch("http://test/v1/actors/main/threads", { method: "POST", headers: { ...authorization, "content-type": "application/json" }, body: JSON.stringify({ name: thread }) })
  expect(created.status).toBe(200)
  expect(await created.json()).toEqual({ actor: "echo", instance: "main", thread })
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

const hasHoldEvent = (events: ReadonlyArray<Event>, type: string, id: string): boolean =>
  events.some((event) => event.type === type && String((event as { readonly id?: unknown }).id) === id)
test("thread initialization blocks registration and survives Durable Object eviction", async () => {
  const directory = (env as Env).ACTORS.getByName(JSON.stringify(["echo", "initialization"]))
  const previous = mountedActor!.supervisor
  let attempts = 0
  let fail = true
  try {
    await directory.init("echo", "initialization")
    await runInDurableObject(directory, async (instance, state) => {
      mountedActor!.supervisor = threadSupervisor({ setup: () => Effect.sync(() => {
        attempts++
        if (fail) throw new Error("setup unavailable")
      }) })
      await expect(instance.createThread("main")).rejects.toThrow("setup unavailable")
      await expect(instance.alarm()).rejects.toThrow("setup unavailable")
      expect(await instance.threadTree()).toEqual([])
      const requested = state.storage.sql.exec<{ event: string }>("SELECT event FROM events ORDER BY seq").toArray().map((row) => JSON.parse(row.event) as Event)
      expect(requested.map((event) => event.type)).toEqual(["ThreadRequested"])
    })
    const pending = (env as Env).THREADS.getByName(JSON.stringify(["echo", "initialization", "main"]))
    await runInDurableObject(pending, async (instance) => {
      await expect(instance.append("main", { type: "MessageReceived", id: "pending", text: "hello", at: 1 })).rejects.toThrow("allocate it before delivery")
      expect((await instance.events("main")).map((event) => event.type)).toEqual(["ThreadCreated"])
    })
    fail = false
    const created = await runInDurableObject(directory, async (instance, state) => {
      const root = await instance.createThread("main")
      const child = await instance.createThread("worker", { parent: "main" })
      expect(attempts).toBe(4)
      expect((await instance.threadTree()).map((node) => node.id)).toContain(root.thread)
      const registered = state.storage.sql.exec<{ event: string }>("SELECT event FROM events ORDER BY seq").toArray().map((row) => JSON.parse(row.event) as Event)
      expect(registered.map((event) => event.type)).toEqual(["ThreadRequested", "ThreadRegistered", "ThreadRequested", "ThreadRegistered"])
      return { root, child }
    })
    await evictDurableObject(directory)
    await runInDurableObject(directory, async (instance) => {
      mountedActor!.supervisor = threadSupervisor({ setup: () => Effect.die(new Error("completed setup ran again")) })
      expect(await instance.createThread("main")).toEqual(created.root)
      expect(await instance.createThread("worker", { parent: "main" })).toEqual(created.child)
    })
    const root = (env as Env).THREADS.getByName(JSON.stringify(["echo", "initialization", "main"]))
    await evictDurableObject(root)
    expect(await root.append("main", { type: "MessageReceived", id: "reopened", text: "hello", at: 2 })).toBe(true)
    await runInDurableObject(root, (_instance, state) => state.storage.delete("threadReady"))
    await evictDurableObject(root)
    expect(await root.append("main", { type: "MessageReceived", id: "legacy", text: "hello", at: 3 })).toBe(true)
  } finally {
    if (previous === undefined) delete mountedActor!.supervisor
    else mountedActor!.supervisor = previous
  }
}, WORKER_INTEGRATION_TIMEOUT_MILLIS)

test("delivery to an unknown Durable Object does not initialize a thread", async () => {
  const target = { actor: "echo", instance: "main", thread: "unallocated" }
  const stub = threadStub(target.thread)
  await runInDurableObject(stub, async (instance) => {
    await expect(instance.deliver({
      link: { source: { provider: "test" }, target },
      event: { type: "MessageReceived", id: "missing", text: "hello", at: 1 }
    })).rejects.toThrow("allocate it before delivery")
  })
  expect(await stub.exists(target.actor, target.instance, target.thread)).toBe(false)
})

const hold = actorMethod({
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.String,
  event: ({ invocation, input, at }) => ({ type: "HoldRequested", id: invocation.id, text: input.text, at }),
  projection: {
    initial: () => [] as ReadonlyArray<Event>,
    step: (events, event) => [...events, event],
    output: (events) => ({
      currentEpoch: () => 0,
      invocationState: (invocation) => !hasHoldEvent(events, "HoldRequested", invocation.id) ? undefined
        : hasHoldEvent(events, "HoldCancelled", invocation.id)
          ? { status: "cancelled" as const, cause: "deadline" as const }
          : hasHoldEvent(events, "HoldCompleted", invocation.id)
            ? { status: "completed" as const, output: "done" }
            : { status: "pending" as const }
    })
  },
  cancellation: {
    event: (cancellation, at) => ({ type: "HoldCancelled", id: cancellation.invocation.id, at })
  }
})
const holdComponent = component<undefined, undefined>({
  name: "hold",
  initial: () => undefined,
  step: () => undefined,
  output: () => ({ view: undefined, transitions: [] })
})
const holdDeadlineActor = actor({ name: "echo", methods: { hold }, components: [holdComponent] })
const holdDeadlineRuntime = actorRuntimeOf(holdDeadlineActor)
const heldInvocation = (deadlineAt: number): Event => ({
  type: "HoldRequested",
  id: "hold-1",
  text: "held",
  call: { invocation: { method: "hold", id: "hold-1", epoch: 0 }, deadlineAt },
  at: deadlineAt - 100
})
const eventsOf = (events: ReadonlyArray<Event>, type: string) => events.filter((event) => event.type === type)
const deadlineThreadHost = async (state: DurableObjectState, thread: string) => {
  const host = await createCloudflareThreadHost({
    storage: state.storage,
    actorName: "echo",
    actorInstance: "main",
    thread,
    actor: holdDeadlineActor,
    keyOf: (event) => holdDeadlineRuntime.keyOf(event) ?? (event.type === "HoldCompleted" ? `hold-complete:${String(event.id)}` : undefined)
  })
  await host.appendAt([threadCreated(host.identity, undefined, 0)], 0)
  return host
}

beforeAll(async () => {
  const db = (env as Env).CATALOG_DB
  const statements = (env as Env & { readonly CATALOG_MIGRATION: string }).CATALOG_MIGRATION
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => db.prepare(statement))
  await db.batch(statements)
  const runtime = ManagedRuntime.make(layerCloudflareModelCatalogRepository(db))
  const repository = await runtime.runPromise(ModelCatalogRepository)
  await Effect.runPromise(repository.write("https://models.test/catalog.json", {
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
  }))
  await runtime.dispose()
})

describe("cloudflare actor", () => {
  test("schema-2 deployment locks use shared definitions and validate selected models", async () => {
    const scope = modelScopeFrom({
      schema: 2,
      providers: { openai: { protocol: "openai-responses", baseUrl: "https://api.openai.test/v1", env: ["OPENAI_API_KEY"] } },
      models: [{ provider: "openai", model_id: "gpt-test", contextWindowTokens: 32000, maxOutputTokens: 4000 }]
    })
    const config = { allow: "*" as const, default: { provider: "openai", model_id: "gpt-test" }, providers: {} }
    expect(await modelCatalogForConfig(config, scope)).toMatchObject({ providers: [{ id: "openai", models: [{ id: "gpt-test", metadata: { contextWindowTokens: 32000 } }] }] })
    await expect(modelCatalogForConfig({ ...config, default: { provider: "openai", model_id: "missing" } }, scope)).rejects.toThrow("absent from models.lock.json")
    const previous = mountedActor!.modelScope
    Object.assign(mountedActor!, { modelScope: scope })
    try {
      const environment = { ...env, TARDIGRADE_CONFIG: { models: { allow: "*", default: config.default } } } as Env
      expect((await modelConfigFrom(environment))?.providers.openai?.baseUrl).toBe("https://api.openai.test/v1")
      expect((await publicCatalog(environment)).snapshot.providers[0]?.models[0]?.metadata?.contextWindowTokens).toBe(32000)
    } finally {
      Object.assign(mountedActor!, { modelScope: previous })
    }
  })

  test("a deployment lock supplies only its matching model scope", async () => {
    const scope = modelScopeFrom({
      schema: 1,
      configDigest: "sha256:24490b510114acf10f5305913084ebe8ee0b0aea03ddf37529a4d4da3fa81ffa",
      catalog: {
        source: "models.dev",
        revision: "bundled",
        refreshedAt: 1,
        status: "cached",
        providers: [{ id: "openai", name: "OpenAI", env: [], models: [{ id: "gpt-test", metadata: { contextWindowTokens: 32000, maxOutputTokens: 4000 } }] }]
      }
    })
    if (!("catalog" in scope)) throw new Error("Expected a legacy catalog scope")
    const config = {
      default: { provider: "openai", model_id: "gpt-test" },
      allow: "*" as const,
      providers: {
        openai: {
          baseUrl: "https://api.openai.test/v1",
          protocol: "openai-chat-completions" as const,
          env: ["OPENAI_API_KEY"]
        }
      }
    }
    const definitions = await upgradeModelLock(scope, config)
    const suppliedLock = Layer.succeed(ModelLock, modelLockService(definitions, config))
    const catalog = await modelCatalogForConfig(config, scope)
    expect(catalog).toMatchObject({ providers: [{ id: "openai" }] })
    const previousScope = mountedActor!.modelScope
    Object.assign(mountedActor!, { modelScope: scope })
    try {
      const state = await modelStateFrom({ ...env, TARDIGRADE_CONFIG: { models: config } } as Env)
      expect(state?.model.providers.openai?.baseUrl).toBe(config.providers.openai.baseUrl)
      expect(state?.catalog.snapshot.providers[0]?.models[0]?.metadata?.contextWindowTokens).toBe(32000)
    } finally {
      Object.assign(mountedActor!, { modelScope: previousScope })
    }
    await expect(modelCatalogForConfig({ ...config, default: { provider: "openai", model_id: "changed" } }, scope))
      .rejects.toThrow("does not match model configuration")
    expect(() => modelScopeFrom({ schema: 1, catalog: scope.catalog })).toThrow("models.lock.json is invalid")
    expect(() => modelScopeFrom({ schema: 2, catalog: {} })).toThrow("models.lock.json is invalid")
    const previousModel = mountedActor!.model
    let configured = false
    Object.assign(mountedActor!, workerModelServices({ model: { providerLayer: (options) => {
      expect(options.model.config).toMatchObject({ max_output_tokens: 1234 })
      return providerLayer(options)
    }, configure: (selected) => {
      configured = true
      expect(selected.model_id).toBe("gpt-test")
      return { maxOutputTokens: 1234, timeout: { idleMs: 12345 } }
    } } }))
    try {
      const settings = await Effect.runPromise(Effect.gen(function* () {
        const selection = yield* ModelSelection
        return yield* selection.settings!()
      }).pipe(Effect.provide(modelLayer(modelsFrom(env as Env, config)).pipe(Layer.provideMerge(suppliedLock)))))
      expect(configured).toBe(true)
      expect(settings.policy).toMatchObject({ maxOutputTokens: 1234, timeout: { idleMs: 12345 } })
    } finally {
      if (previousModel === undefined) delete mountedActor!.model
      else mountedActor!.model = previousModel
    }
    const binding = await Effect.runPromise(ModelLock.pipe(Effect.provide(
      modelLayer(modelsFrom(env as Env, config)).pipe(Layer.provideMerge(suppliedLock))
    )))
    expect(binding.resolve()).toMatchObject({
      model: config.default,
      contextWindowTokens: 32000,
      models: { allow: "*" }
    })
    expect(binding.definitions.models).toContainEqual(expect.objectContaining({ ...config.default, maxOutputTokens: 4000 }))
    expect(() => binding.resolve({ provider: "openai", model_id: "outside-lock" })).toThrow("absent from models.lock.json")
    const restricted = await Effect.runPromise(ModelLock.pipe(Effect.provide(
      modelLayer(modelsFrom(env as Env, { ...config, allow: [] })).pipe(Layer.provideMerge(Layer.succeed(ModelLock, modelLockService(definitions, { ...config, allow: [] }))))
    )))
    expect(() => restricted.resolve()).toThrow("excluded by the host model policy")
  })

  test("low-level delivery requires provisioning before persistence", async () => {
    await runInDurableObject(threadStub("root-reservation"), async (_instance, state) => {
      const host = await createCloudflareThreadHost({
        storage: state.storage, actorName: "echo", actorInstance: "main", thread: "root-reservation",
        actor: actorFromProjections({ transitions: [], keyOf: () => undefined })
      })
      try {
        const event = { type: "MessageReceived", id: "first", at: 1 }
        await expect(host.commitRoot(event)).rejects.toThrow("delivery requires a created thread")
        await expect(host.stageRoot(event)).rejects.toThrow("delivery requires a created thread")
        expect(await host.read()).toEqual([])
        await host.appendAt([threadCreated(host.identity, undefined, 0)], 0)
        await host.stageRoot(event)
        await host.commitRoot({ ...event, id: "second", at: 2 })
        expect((await host.read()).filter((event) => event.type === "ThreadCreated")).toHaveLength(1)
        expect((await host.read()).filter((event) => event.type === "MessageReceived").map((event) => event.id)).toEqual(["first", "second"])
      } finally {
        await host.close()
      }
    })
  })

  test("root, routed, and staged ingress reject invalid context before persistence", async () => {
    await runInDurableObject(threadStub("ingress-rejection"), async (_instance, state) => {
      const target = { actor: "echo", instance: "main", thread: "ingress-rejection" }
      const host = await createCloudflareThreadHost({
        storage: state.storage, actorName: target.actor, actorInstance: target.instance, thread: target.thread,
        actor: actorFromProjections({ transitions: [], keyOf: () => undefined })
      })
      try {
        const call = { invocation: { method: "run", id: "call", epoch: -1 } }
        const event = { type: "MessageReceived", id: "call", at: 1 }
        const source = { ...target, thread: "parent" }
        const envelope = { link: { source, target }, event, call, lineage: { parent: source, depth: 1 } }
        await expect(host.commitRoot({ ...event, call })).rejects.toThrow('["invocation"]["epoch"]')
        await expect(host.stageRoot({ ...event, call })).rejects.toThrow('["invocation"]["epoch"]')
        await expect(host.commit(envelope)).rejects.toThrow('["invocation"]["epoch"]')
        await expect(host.stage(envelope)).rejects.toThrow('["invocation"]["epoch"]')
        expect(await host.read()).toEqual([])
      } finally {
        await host.close()
      }
    })
  })

  test("durable publication does not wait for application observers and excludes staged heads", async () => {
    const commits = await runInDurableObject(threadStub("ag.commit-observer"), async (_instance, state) => {
      const seen: Array<number> = []
      const published: Array<number> = []
      let observed = () => {}
      const firstObserved = new Promise<void>((resolve) => { observed = resolve })
      const blocked = Promise.withResolvers<void>()
      const host = await createCloudflareThreadHost({
        storage: state.storage,
        actorName: "echo",
        actorInstance: "main",
        thread: "ag.commit-observer",
        actor: actorFromProjections({ transitions: [], keyOf: () => undefined }),
        onPublish: (head) => { published.push(head) },
        commitObserver: {
          onCommit: ({ head }) => Effect.gen(function* () {
            seen.push(head)
            if (head === 2) {
              observed()
              yield* Effect.promise(() => blocked.promise)
            }
          })
        },
        retainCommitTask: (task) => state.waitUntil(task)
      })

      try {
        await host.appendAt([threadCreated(host.identity, undefined, 0)], 0)
        await host.commitRoot({ type: "MessageReceived", id: "first", at: 1 })
        await firstObserved
        await host.commitRoot({ type: "MessageReceived", id: "second", at: 2 })
        expect(published.at(-1)).toBe(3)
        expect((await host.readPage(2, 1))[0]?.event).toMatchObject({ id: "second" })
        expect(seen.at(-1)).toBe(2)
        await host.stageRoot({ type: "MessageReceived", id: "third", at: 3 })
        await state.storage.sync()
        expect(published.at(-1)).toBe(3)
        host.publishStaged()
        expect(published.at(-1)).toBe(4)
        expect(seen.at(-1)).toBe(2)
      } finally {
        blocked.resolve()
        await host.close()
      }
      return seen
    })

    expect(commits.at(-1)).toBe(4)
  })

  test("incremental commits decode only the creation record and new tail", async () => {
    const decoded = await runInDurableObject(threadStub("ag.incremental-ingress"), async (_instance, state) => {
      const batches: Array<number> = []
      const host = await createCloudflareThreadHost({
        storage: state.storage,
        actorName: "echo",
        actorInstance: "main",
        thread: "ag.incremental-ingress",
        actor: actorFromProjections({ transitions: [], keyOf: () => undefined }),
        store: {
          codec: {
            encode: plaintextEventCodec.encode,
            decode: (events) => Effect.sync(() => {
              batches.push(events.length)
              return events
            })
          },
          indexKey: Effect.succeed
        }
      })

      await host.appendAt([threadCreated(host.identity, undefined, 0)], 0)
      await host.commitRoot({ type: "MessageReceived", id: "first", at: 1 })
      await host.drive()
      expect(await host.resting()).toBe(true)
      batches.length = 0

      await host.commitRoot({ type: "MessageReceived", id: "second", at: 2 })
      await host.drive()
      expect(await host.resting()).toBe(true)
      await host.close()
      return batches
    })

    expect(decoded).toEqual([1])
  })

  test("a cold empty thread reports rest before settlement", async () => {
    const resting = await runInDurableObject(threadStub("ag.cold-resting"), async (_instance, state) => {
      const host = await createCloudflareThreadHost({
        storage: state.storage,
        actorName: "echo",
        actorInstance: "main",
        thread: "ag.cold-resting",
        actor: actorFromProjections({ transitions: [], keyOf: () => undefined })
      })
      const result = await host.resting()
      await host.close()
      return result
    })

    expect(resting).toBe(true)
  })

  test("method-less actors retain outgoing call deadlines", async () => {
    const deadlineAt = Date.now() - 1
    const result = await runInDurableObject(threadStub("ag.method-less-deadline"), async (_instance, state) => {
      const host = await createCloudflareThreadHost({
        storage: state.storage,
        actorName: "echo",
        actorInstance: "main",
        thread: "ag.method-less-deadline",
        actor: actorFromProjections({ transitions: [], keyOf: () => undefined })
      })
      await host.appendAt([threadCreated(host.identity, undefined, 0)], 0)
      await host.commitRoot({
        type: "CallDispatched",
        id: "outgoing-1",
        method: "inspect",
        target: "remote:main:shared",
        input: {},
        timeoutMs: 10,
        deadlineAt,
        at: deadlineAt - 10
      })
      const deadline = await host.nextMethodDeadline()
      await host.recordAlarm(deadlineAt)
      const events = await host.read()
      await host.close()
      return { deadline, events }
    })

    expect(result.deadline).toBe(deadlineAt)
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "AlarmFired",
      scheduledFor: deadlineAt
    }))
  })

  test("an alarm commits its deadline cancellation atomically", async () => {
    await runInDurableObject(threadStub("deadline-atomicity"), async (_instance, state) => {
      const host = await deadlineThreadHost(state, "ag.deadline-atomicity")
      const deadlineAt = Date.now() - 1
      await host.commitRoot(heldInvocation(deadlineAt))
      await host.drive()
      expect(eventsOf(await host.read(), "HoldRequested")).toHaveLength(1)
      expect(eventsOf(await host.read(), "AlarmFired")).toEqual([])
      expect(host.work()).toBe(0)
      state.storage.sql.exec(`CREATE TRIGGER reject_deadline_cancellation
        BEFORE INSERT ON events
        WHEN NEW.key LIKE 'cx:%'
        BEGIN SELECT RAISE(ABORT, 'reject deadline cancellation'); END`)
      await expect(host.recordAlarm(Date.now())).rejects.toThrow()
      expect(eventsOf(await host.read(), "AlarmFired")).toEqual([])
      expect(eventsOf(await host.read(), "CancellationRequested")).toEqual([])
      expect(host.work()).toBe(0)
      state.storage.sql.exec("DROP TRIGGER reject_deadline_cancellation")
      await host.recordAlarm(Date.now())
      const afterAlarm = await host.read()
      const alarmAt = afterAlarm.findIndex((event) => event.type === "AlarmFired")
      expect(afterAlarm.findIndex((event) => event.type === "CancellationRequested")).toBeGreaterThan(alarmAt)
      expect(alarmAt).toBeGreaterThanOrEqual(0)
      expect(host.work()).toBe(1)
      await host.drive()
      expect(eventsOf(await host.read(), "HoldCancelled")).toHaveLength(1)
      expect(await host.resting()).toBe(true)
      expect(host.work()).toBe(0)
      await host.close()
    })
  }, WORKER_INTEGRATION_TIMEOUT_MILLIS)

  test("a stale deadline cancellation leaves a settled invocation unchanged", async () => {
    await runInDurableObject(threadStub("stale-deadline-cancellation"), async (_instance, state) => {
      const host = await deadlineThreadHost(state, "ag.stale-deadline-cancellation")
      const invocation = { method: "hold", id: "hold-1", epoch: 0 }
      const deadlineAt = Date.now() - 1
      await host.commitRoot(heldInvocation(deadlineAt))
      await host.drive()
      const stale = deadlineCancellationEventsAt(await host.read(), { hold }, Date.now())
      expect(stale).toHaveLength(1)
      expect(stale[0]).toMatchObject({ type: "CancellationRequested", cause: "deadline", invocation })
      await host.commitRoot({ type: "HoldCompleted", id: "hold-1", at: deadlineAt - 50 })
      await host.drive()
      for (const event of stale) await host.commitRoot(event)
      await host.drive()
      const afterStale = await host.read()
      expect(eventsOf(afterStale, "HoldCompleted")).toHaveLength(1)
      expect(eventsOf(afterStale, "HoldCancelled")).toEqual([])
      expect(await host.resting()).toBe(true)
      await host.close()
    })
  }, WORKER_INTEGRATION_TIMEOUT_MILLIS)

  test("the creation cache follows the record accepted by storage", async () => {
    const target = { actor: "echo", instance: "main", thread: "ag.creation-cache" }
    const source = { actor: "echo", instance: "main", thread: "ag.requested-parent" }
    const storedParent = { actor: "echo", instance: "main", thread: "ag.stored-parent" }
    const result = await runInDurableObject(threadStub("ag.creation-cache"), async (_instance, state) => {
      let injected = false
      const host = await createCloudflareThreadHost({
        storage: state.storage,
        actorName: "echo",
        actorInstance: "main",
        thread: target.thread,
        actor: actorFromProjections({ transitions: [], keyOf: () => undefined }),
        store: {
          codec: {
            encode: (events) => Effect.sync(() => {
              if (!injected && events.some((event) => event.type === "ThreadCreated")) {
                injected = true
                state.storage.sql.exec(
                  `INSERT INTO events (seq, key, event) VALUES (1, 'thread:created', '${JSON.stringify({
                    type: "ThreadCreated",
                    address: target,
                    parent: storedParent,
                    depth: 1,
                    at: 1
                  })}')`
                )
              }
              return events
            }),
            decode: Effect.succeed
          },
          indexKey: Effect.succeed
        }
      })
      let message = ""
      try {
        await host.appendAt([threadCreated(target, { parent: source, depth: 1 }, 1)], 0)
        await host.commit({
          link: { source, target },
          event: { type: "MessageReceived", id: "creation-race", at: 2 },
          lineage: { parent: source, depth: 1 }
        })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      const events = await host.read()
      await host.close()
      return { message, events }
    })

    expect(result.message).toContain("already has different lineage")
    expect(result.events[0]).toEqual(expect.objectContaining({
      type: "ThreadCreated",
      parent: storedParent
    }))
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

  test("an opaque actor instance ref retains its delimiter", async () => {
    const response = await SELF.fetch("http://test/v1/actors/tenant%3Awest", {
      method: "PUT",
      headers: authorization
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ actor: "tenant:west", definition: "echo" })
  })

  test("actor instance path parameters are decoded once", async () => {
    const response = await SELF.fetch("http://test/v1/actors/tenant%252Fwest", {
      method: "PUT",
      headers: authorization
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ actor: "tenant%2Fwest", definition: "echo" })
  })

  test("D1 authoring snapshots do not supply runtime model discovery", async () => {
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
    const runtime = ManagedRuntime.make(layerCloudflareModelCatalogRepository((env as Env).CATALOG_DB))
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
    const providers = await SELF.fetch("http://test/v1/providers?search=open&limit=1")
    expect(await publicCatalog(env as Env)).toEqual({})
    expect(providers.status).toBe(503)
  })

  test("D1 persists a catalog larger than one SQLite value", async () => {
    const padding = "catalog-metadata".repeat(512)
    const snapshot: ModelCatalog = {
      source: "models.dev",
      revision: "workers-large-catalog",
      refreshedAt: 2,
      status: "fresh",
      providers: [{
        id: "bulk",
        name: "Bulk",
        env: ["BULK_API_KEY"],
        models: Array.from({ length: 600 }, (_, index) => ({
          id: `model-${index}`,
          name: `${index}:${padding}`,
          metadata: { contextWindowTokens: 128_000 }
        }))
      }]
    }
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength).toBeGreaterThan(4_425_714)
    const runtime = ManagedRuntime.make(layerCloudflareModelCatalogRepository((env as Env).CATALOG_DB))
    try {
      const repository = await runtime.runPromise(ModelCatalogRepository)
      await Effect.runPromise(repository.write("https://models.test/large.json", snapshot))
      const stored = await Effect.runPromise(repository.readScope("https://models.test/large.json", {
        providers: ["bulk"],
        policy: { allow: [{ provider: "bulk", model_ids: ["model-599"] }] }
      }))
      expect(stored).toEqual({
        ...snapshot,
        status: "cached",
        providers: [{ ...snapshot.providers[0]!, models: [snapshot.providers[0]!.models[599]!] }]
      })
    } finally {
      await runtime.dispose()
    }
  }, WORKER_INTEGRATION_TIMEOUT_MILLIS)

  test("a failed D1 generation leaves the active catalog unchanged", async () => {
    const sourceUrl = "https://models.test/atomic.json"
    const catalog = (revision: string, model: string): ModelCatalog => ({
      source: "models.dev",
      revision,
      refreshedAt: revision === "old" ? 1 : 2,
      status: "fresh",
      providers: [{
        id: "openai",
        name: "OpenAI",
        env: ["OPENAI_API_KEY"],
        models: [{ id: model, metadata: { contextWindowTokens: 128_000 } }]
      }]
    })
    const db = (env as Env).CATALOG_DB
    const runtime = ManagedRuntime.make(layerCloudflareModelCatalogRepository(db, { writeBatchSize: 1 }))
    try {
      const repository = await runtime.runPromise(ModelCatalogRepository)
      await Effect.runPromise(repository.write(sourceUrl, catalog("old", "working")))
      await db.prepare(
        `CREATE TRIGGER refuse_catalog_generation BEFORE INSERT ON catalog_models
         WHEN NEW.source_url = '${sourceUrl}' AND NEW.model_id = 'refused'
         BEGIN SELECT RAISE(FAIL, 'refused catalog generation'); END`
      ).run()
      const refused = catalog("new", "refused")
      refused.providers[0]!.models.unshift({ id: "staged", metadata: { contextWindowTokens: 128_000 } })
      await expect(Effect.runPromise(repository.write(sourceUrl, refused))).rejects.toThrow()
      expect(await Effect.runPromise(repository.read(sourceUrl))).toEqual({ ...catalog("old", "working"), status: "cached" })
      const [providers, models] = await Promise.all([
        db.prepare(
          "SELECT COUNT(*) AS count FROM catalog_providers WHERE source_url = ? AND generation != (SELECT active_generation FROM catalog_sources WHERE source_url = ?)"
        ).bind(sourceUrl, sourceUrl).first<{ count: number }>(),
        db.prepare(
          "SELECT COUNT(*) AS count FROM catalog_models WHERE source_url = ? AND generation != (SELECT active_generation FROM catalog_sources WHERE source_url = ?)"
        ).bind(sourceUrl, sourceUrl).first<{ count: number }>()
      ])
      expect([providers?.count, models?.count]).toEqual([0, 0])
    } finally {
      await db.prepare("DROP TRIGGER IF EXISTS refuse_catalog_generation").run()
      await runtime.dispose()
    }
  })

  test("actor storage contains no catalog tables", async () => {
    const response = await SELF.fetch("http://test/v1/actors/main", { method: "PUT", headers: authorization })
    expect(response.status).toBe(200)
    const catalogTables = await runInDurableObject(controlStub(), (_instance, durable) =>
      durable.storage.sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'catalog_%'"
      ).toArray().map((row) => row.name)
    )
    expect(catalogTables).toEqual([])
  })

  test("public API docs describe only mounted Worker routes", async () => {
    const page = await SELF.fetch("http://test/docs")
    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toContain("text/html")
    const html = await page.text()
    expect(html).toContain("Scalar")
    expect(html).toContain("--scalar-background-1: #f3f0e4")

    const response = await SELF.fetch("http://test/openapi.json")
    expect(response.status).toBe(200)
    const spec = await response.json() as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>>; components: { schemas: Record<string, unknown> } }
    expect(Object.keys(spec.paths).sort()).toEqual([
      "/healthz", "/v1/metadata", "/v1/providers", "/v1/models", "/v1/methods",
      "/v1/actors/{id}", "/v1/actors/{id}/threads", "/v1/actors/{id}/threads/{thread}/events",
      "/v1/actors/{id}/threads/{thread}/fork",
      "/v1/actors/{id}/threads/{thread}/methods/{method}",
      "/v1/actors/{id}/threads/{thread}/methods/{method}/calls/{call}",
      "/v1/actors/{id}/threads/{thread}/methods/{method}/calls/{call}/cancellation"
    ].sort())
    expect(spec.paths["/healthz"]?.get?.responses["200"]).toMatchObject({
      content: { "application/json": { schema: { properties: { status: { enum: ["ready"] }, actor: { type: "string" } } } } }
    })
    expect(spec.components.schemas.ThreadSummary).toMatchObject({
      properties: { id: { type: "string" }, events: { type: "number" }, status: { type: "string" } }
    })
    expect(spec.paths["/v1/actors/{id}/threads/{thread}/events"]?.post?.responses).toHaveProperty("202")
    for (const [path, method, statuses] of [
      ["/healthz", "get", ["200"]],
      ["/v1/metadata", "get", ["200", "401", "503"]],
      ["/v1/actors/{id}", "put", ["200", "400", "401", "503"]],
      ["/v1/actors/{id}", "get", ["200", "400", "401", "404", "503"]],
      ["/v1/actors/{id}/threads", "post", ["200", "400", "401", "404", "503"]],
      ["/v1/actors/{id}/threads", "get", ["200", "400", "401", "404", "503"]],
      ["/v1/actors/{id}/threads/{thread}/fork", "post", ["200", "400", "401", "404", "409", "503"]],
      ["/v1/actors/{id}/threads/{thread}/events", "post", ["202", "400", "401", "404", "503"]],
      ["/v1/actors/{id}/threads/{thread}/events", "get", ["200", "400", "401", "404", "500", "503"]]
    ] as const) {
      expect(Object.keys(spec.paths[path]![method]!.responses).sort()).toEqual(statuses)
    }
    expect((await SELF.fetch("http://test/v1/methods")).status).toBe(401)
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
    expect(await accepted.json()).toMatchObject({
      actor: "main",
      thread: "root",
      method: "echo",
      call: "workers-smoke",
      deadlineAt: expect.any(Number)
    })
    expect(await methodState("root", "workers-smoke")).toEqual({ status: "completed", output: "workers:root:1:Run in workerd." })
    const wrongActor = await SELF.fetch("http://test/v1/actors/main/threads/root/methods/echo/calls/workers-smoke?actor=other&epoch=0", { headers: authorization })
    expect(wrongActor.status).toBe(400)
    expect(await alarm("root")).toBeNull()
    const client = makeActorClient({
      baseUrl: "http://test",
      token: "workers-test-token",
      fetch: (input, init) => SELF.fetch(input, init)
    })
    const handle = await client.call("main", "root", "echo", { id: "workers-smoke", input: { text: "Run in workerd." } })
    expect(handle)
      .toMatchObject({
        actor: "main",
        thread: "root",
        method: "echo",
        id: "workers-smoke",
        deadlineAt: expect.any(Number)
      })
    expect(await client.state(handle.reference))
      .toEqual({ status: "completed", output: "workers:root:1:Run in workerd." })
    const methodUrl = "http://test/v1/actors/main/threads/root/methods/echo"
    const retried = await SELF.fetch(methodUrl, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json", "Idempotency-Key": "workers-smoke" },
      body: JSON.stringify({ text: "Run in workerd." })
    })
    expect(retried.status).toBe(202)
    expect(retried.headers.get("location")).toContain("/calls/workers-smoke")
    for (const [headers, input, status] of [
      [{ ...authorization }, { text: "missing key" }, 400],
      [{ ...authorization, "Idempotency-Key": "invalid" }, { text: 42 }, 400],
      [{ authorization: "Bearer wrong", "Idempotency-Key": "invalid" }, { text: "unauthorized" }, 401]
    ] as const) {
      const refused = await SELF.fetch(methodUrl, {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(input)
      })
      expect(refused.status).toBe(status)
    }
    const badEpoch = await SELF.fetch(`${methodUrl}/calls/workers-smoke?epoch=-1`, { headers: authorization })
    expect(badEpoch.status).toBe(400)
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
    expect(await threads.json()).toEqual([{ id: "root", depth: 0, events: 3, lastAt: expect.any(Number), status: "settled" }])
    expect(await client.list("main")).toEqual([{ id: "root", depth: 0, events: 3, lastAt: expect.any(Number), status: "settled" }])
    expect(await client.methods()).toEqual([expect.objectContaining({ name: "echo" })])
    expect(await client.metadata()).toEqual({ name: "echo", storage: { kind: "durable-object" } })
  }, WORKER_INTEGRATION_TIMEOUT_MILLIS)

  test("the actor directory persists concurrent generated thread assignments", async () => {
    const directory = controlStub()
    await directory.init("echo", "main")
    const request = { kind: "root" as const, coordinate: { actor: "echo", instance: "main", thread: "" }, key: "generated" }
    const results = await Promise.all(Array.from({ length: 10 }, () => directory.allocateThread(request)))
    expect(new Set(results.map((target) => target.thread)).size).toBe(1)
    expect(results[0]!.thread).toMatch(/^[a-z]+-[a-z]+-[a-z2-7]{4}$/)
    expect(await directory.allocateThread(request)).toEqual(results[0])
    const rows = await runInDurableObject(directory, (_instance, state) =>
      state.storage.sql.exec<{ thread: string }>("SELECT json_extract(event, '$.thread') AS thread FROM events WHERE json_extract(event, '$.type') = 'ThreadRequested' AND json_extract(event, '$.allocationKey') IS NOT NULL").toArray())
    expect(rows.map((row) => row.thread)).toContain(results[0]!.thread)
    expect(rows.filter((row) => row.thread === results[0]!.thread)).toHaveLength(1)
    expect((await directory.threadTree()).some((node) => node.id === results[0]!.thread)).toBe(true)
    const tables = await runInDurableObject(directory, (_instance, state) =>
      state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray())
    expect(tables.map((row) => row.name)).not.toContain("thread_assignments")
  })

  test("an actor action allocates a root through its Durable Object host before invoking it", async () => {
    await createThread("sdk-caller")
    const accepted = await SELF.fetch("http://test/v1/actors/main/threads/sdk-caller/methods/echo/calls/sdk-flow", {
      method: "PUT", headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ text: "allocate-root" })
    })
    expect(accepted.status).toBe(202)
    expect(await methodState("sdk-caller", "sdk-flow")).toEqual({
      status: "completed", output: "workers:sdk-root:1:hello"
    })
    const response = await SELF.fetch("http://test/v1/actors/main/threads/sdk-root/events", { headers: authorization })
    expect(response.status).toBe(200)
    const events = await response.json() as ReadonlyArray<{ readonly event: { readonly type: string; readonly parent?: unknown } }>
    expect(events.filter(({ event }) => event.type === "ThreadCreated")).toHaveLength(1)
    expect(events[0]?.event.parent).toBeUndefined()
    expect(events.filter(({ event }) => event.type === "EchoRequested")).toHaveLength(1)
    const listed = await SELF.fetch("http://test/v1/actors/main/threads", { headers: authorization })
    expect(await listed.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "sdk-root", depth: 0 })]))
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
    expect(first).toEqual({ status: "completed", output: "workers:application-a:1:first" })
    expect(second).toEqual({ status: "completed", output: "workers:application-b:1:second" })
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
      output: "workers:sealed:1:classified prompt"
    })
    const repeated = await SELF.fetch("http://test/v1/actors/main/threads/sealed/methods/echo/calls/sealed-call", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ text: prompt })
    })
    expect(repeated.status).toBe(202)
    expect(await methodState("sealed", "sealed-call")).toEqual({
      status: "completed",
      output: "workers:sealed:1:classified prompt"
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

  test("HTTP forks a prefix through the event codec onto a runnable dest", async () => {
    const secret = "classified-fork-secret"
    await createThread("fork-src")
    const appended = await SELF.fetch("http://test/v1/actors/main/threads/fork-src/methods/echo/calls/m1", {
      method: "PUT",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ text: secret })
    })
    expect(appended.status).toBe(202)
    const forked = await SELF.fetch("http://test/v1/actors/main/threads/fork-src/fork", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ event: "m1", name: "fork-dst" })
    })
    expect(forked.status).toBe(200)
    expect(await forked.json()).toEqual({ actor: "echo", instance: "main", thread: "fork-dst", seq: 2 })
    await expect.poll(async () => (await threadStub("fork-dst").events("fork-dst")).map((event) => event.type))
      .toEqual(["ThreadCreated", "EchoRequested", "ThreadForked", "EchoCompleted"])
    const visible = await SELF.fetch("http://test/v1/actors/main/threads/fork-dst/events", { headers: authorization })
    const rows = await visible.json() as ReadonlyArray<{ readonly event: { readonly type: string; readonly id?: string; readonly text?: string; readonly source?: unknown } }>
    expect(rows.map((row) => row.event.type)).toEqual(["ThreadCreated", "EchoRequested", "ThreadForked", "EchoCompleted"])
    expect(rows[1]?.event).toMatchObject({ type: "EchoRequested", id: "m1", text: secret })
    expect(rows[2]?.event).toMatchObject({ type: "ThreadForked", source: { actor: "echo", instance: "main", thread: "fork-src" } })
    const raw = await runInDurableObject(threadStub("fork-dst"), (_instance, state) =>
      state.storage.sql.exec<{ readonly event: string }>("SELECT event FROM events ORDER BY seq").toArray()
    )
    expect(raw.every((row) => !row.event.includes(secret))).toBe(true)
    expect(raw.every((row) => {
      const encrypted = JSON.parse(row.event) as { readonly iv?: unknown; readonly ciphertext?: unknown }
      return typeof encrypted.iv === "string" && typeof encrypted.ciphertext === "string"
    })).toBe(true)
    const unknown = await SELF.fetch("http://test/v1/actors/main/threads/ghost/fork", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ seq: 1 })
    })
    expect(unknown.status).toBe(404)
    const missing = await SELF.fetch("http://test/v1/actors/main/threads/fork-src/fork", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ seq: 99, name: "missing" })
    })
    expect(missing.status).toBe(400)
    const again = await SELF.fetch("http://test/v1/actors/main/threads/fork-src/fork", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ seq: 2, name: "fork-dst" })
    })
    expect(again.status).toBe(200)
    expect((await SELF.fetch("http://test/v1/actors/main/threads/fork-dst/events", { headers: authorization })).json()).resolves.toHaveLength(4)
    const secondRequest = { method: "POST", headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ seq: 3, name: "fork-second" }) }
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await SELF.fetch("http://test/v1/actors/main/threads/fork-dst/fork", secondRequest)).status).toBe(200)
    }
    const secondEvents = await threadStub("fork-second").events("fork-second")
    expect(secondEvents.filter((event) => event.type === "ThreadForked").map((event) => event.destination))
      .toEqual(["fork-dst", "fork-second"])
    const occupied = await SELF.fetch("http://test/v1/actors/main/threads/fork-dst/fork", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ seq: 2, name: "fork-src" })
    })
    expect(occupied.status).toBe(409)
  }, WORKER_INTEGRATION_TIMEOUT_MILLIS)

  test("a Thread DO commits an expected-head append once under concurrency", async () => {
    await createThread("fork-race")
    const stub = threadStub("fork-race")
    const row = { type: "MessageReceived", id: "race", text: "x", at: 1 } as Event
    const results = await Promise.all([1, 2, 3, 4].map(() => stub.appendAt([row, { ...row, id: "race-2" }], 1)))
    expect(results.filter((result) => result.appended === 2)).toHaveLength(1)
    expect(results.filter((result) => result.appended === 0)).toHaveLength(3)
    expect(results.every((result) => result.head === 3)).toBe(true)
    expect(await stub.events("fork-race")).toHaveLength(3)
  }, WORKER_INTEGRATION_TIMEOUT_MILLIS)

  test("opaque child addresses execute and round-trip through the public API", async () => {
    const directory = controlStub()
    await directory.init("echo", "main")
    await directory.createThread("ag.opaque-parent")
    const parent = { actor: "echo", instance: "main", thread: "ag.opaque-parent" }
    const target = { ...parent, thread: "thread_opaque-child" }
    await directory.allocateThread({ kind: "child", parent, child: childKeyOf(target.thread) })
    await directory.deliverChild({
      link: { source: parent, target },
      event: { type: "MessageReceived", id: "opaque-brief", text: "hello", at: 1 },
      lineage: { parent, depth: 1 }
    })
    const tree = await directory.threadTree()
    expect(tree.find((node) => node.id === "opaque-parent")?.children).toEqual([
      expect.objectContaining({ id: target.thread, parent: "opaque-parent", depth: 1 })
    ])
    const accepted = await SELF.fetch(`http://test/v1/actors/main/threads/${target.thread}/methods/echo/calls/opaque-call`, {
      method: "PUT", headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello opaque" })
    })
    expect(accepted.status).toBe(202)
    expect(await methodState(target.thread, "opaque-call")).toEqual({
      status: "completed", output: `workers:${target.thread}:1:hello opaque`
    })
    const read = await SELF.fetch(`http://test/v1/actors/main/threads/${target.thread}/events`, { headers: authorization })
    expect(read.status).toBe(200)
    const rows = await read.json() as Array<{ readonly event: { readonly type: string; readonly address?: unknown } }>
    expect(rows[0]?.event.address).toEqual(target)
    const native = (env as Env).THREADS.getByName(JSON.stringify(["echo", "main", target.thread]))
    expect((await native.events(target.thread))[0]).toMatchObject({ address: target })
  })

  test("supervisor recovery retains a fully published fork", async () => {
    const directory = controlStub()
    await directory.init("echo", "main")
    const source = await directory.createThread("fork-reservation-source")
    const target = await directory.allocateThread({ kind: "root", coordinate: { ...source, thread: "fork-reservation-dest" }, fork: { source, seq: 1 } })
    const stub = (env as Env).THREADS.getByName(JSON.stringify(["echo", "main", target.thread]))
    await stub.init("echo", "main", target.thread)
    await runInDurableObject(directory, (instance) => instance.alarm())
    expect((await stub.events(target.thread)).map((event) => event.type)).toEqual(["ThreadCreated", "ThreadForked"])
    expect((await directory.threadTree()).some((node) => node.id === target.thread)).toBe(true)
    const result = await directory.forkThread(source.thread, { seq: 1 }, target.thread)
    expect(result).toMatchObject({ ok: true, coordinate: target })
    expect((await stub.events(target.thread)).map((event) => event.type)).toEqual(["ThreadCreated", "ThreadForked"])
    expect((await directory.threadTree()).some((node) => node.id === target.thread)).toBe(true)
    expect(await directory.forkThread(source.thread, { seq: 1 }, target.thread)).toEqual(result)
  })

  test("a child request creates and registers before delivery with its placement", async () => {
    const directory = controlStub()
    await directory.init("echo", "main")
    const parent = await directory.createThread("requested-parent")
    const request = { kind: "child" as const, parent, child: childKeyOf("requested-child") }
    const target = await directory.allocateThread(request)
    expect(target.thread).toBe("requested-child")
    await runInDurableObject(directory, (instance) => instance.alarm())
    expect((await directory.threadTree()).find((node) => node.id === parent.thread)?.children).toEqual([
      expect.objectContaining({ id: target.thread, placement: "independent" })
    ])
    await directory.createThread("requested-unrelated")
    await directory.deliverChild({
      link: { source: parent, target },
      event: { type: "MessageReceived", id: "requested-brief", text: "hello", at: 1 },
      lineage: { parent, depth: 1, placement: "independent" }
    })
    expect(await directory.allocateThread(request)).toEqual(target)
    expect((await directory.threadTree()).find((node) => node.id === parent.thread)?.children).toEqual([
      expect.objectContaining({ id: target.thread, parent: parent.thread, depth: 1, placement: "independent" })
    ])
    const rows = await runInDurableObject(directory, (_instance, state) =>
      state.storage.sql.exec<{ event: string }>("SELECT event FROM events WHERE json_extract(event, '$.thread') = 'requested-child' ORDER BY seq").toArray())
    expect(rows.map((row) => JSON.parse(row.event))).toEqual([
      expect.objectContaining({ type: "ThreadRequested", allocationKey: expect.any(String), thread: target.thread }),
      expect.objectContaining({ type: "ThreadRegistered", placement: "independent", thread: target.thread })
    ])
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
      maxDepth: 2,
      placement: "independent" as const
    }
    const requested = await runInDurableObject(directory, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO events (seq, key, event)
         VALUES (
           (SELECT COALESCE(MAX(seq), 0) + 1 FROM events),
           'thread:requested:ag.directory-child',
           ?
         )`, JSON.stringify({ type: "ThreadRequested", thread: target.thread, parentThread: parent.thread, depth: 1, placement: "independent", at: 1,
          allocationRequest: { kind: "child", parent, child: target.thread, maxDepth: lineage.maxDepth, placement: lineage.placement } })
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
    await runInDurableObject(directory, async (instance) => expect(instance.deliverChild({
      link: { source: parent, target },
      event: { type: "MessageReceived", id: "directory-child-message", text: "hello", at: 2 },
      lineage
    })).rejects.toThrow("allocate it before delivery"))
    await directory.ensureThreadReady(target.thread)
    await directory.deliverChild({
      link: { source: parent, target },
      event: { type: "MessageReceived", id: "directory-child-message", text: "hello", at: 2 },
      lineage
    })
    const fresh = { actor: "echo", instance: "main", thread: "ag.directory-fresh" }
    await runInDurableObject(directory, async (instance) => expect(instance.deliverChild({
      link: { source: parent, target: fresh },
      event: { type: "MessageReceived", id: "directory-fresh-message", text: "hello", at: 3 },
      lineage
    })).rejects.toThrow("allocate it before delivery"))
    await directory.allocateThread({ kind: "child", parent, child: childKeyOf(fresh.thread), maxDepth: lineage.maxDepth, placement: lineage.placement })
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
    const childEvents = await threadStub("ag.directory-child").events("ag.directory-child")
    expect(childEvents.map((event) => event.type)).toEqual(["ThreadCreated", "MessageReceived"])
    expect(childEvents[0]).toMatchObject({ depth: 1, maxDepth: 2 })
    const actorEvents = await runInDurableObject(directory, (_instance, state) =>
      state.storage.sql.exec<{ event: string }>("SELECT event FROM events ORDER BY seq").toArray()
    )
    expect(actorEvents
      .map((row) => JSON.parse(row.event) as { readonly type: string; readonly thread: string })
      .filter((event) => event.thread.startsWith("ag.directory-"))
      .map((event) => event.type)).toEqual([
      "ThreadRequested",
      "ThreadRegistered",
      "ThreadRequested",
      "ThreadRegistered",
      "ThreadRequested",
      "ThreadRegistered"
    ])
  })

  // claimTree writes requested-and-registered thread records straight into an actor instance's
  // own log, the shape the supervisor's registration writes, so a tree test states a roster
  // outright. The instance is the fixture's own, because worker storage outlives a test and a
  // roster shaped for bounds would poison another test's unbounded read.
  const claimTree = async (
    instance: string,
    claims: ReadonlyArray<readonly [thread: string, parent: string | undefined, depth: number]>,
    extra: ReadonlyArray<readonly [key: string | null, event: string]> = []
  ): Promise<void> => {
    const directory = (env as Env).ACTORS.getByName(JSON.stringify(["echo", instance]))
    await directory.init("echo", instance)
    await runInDurableObject(directory, (_instance, state) => {
      const insert = (key: string | null, event: string) =>
        state.storage.sql.exec(
          `INSERT INTO events (seq, key, event) VALUES ((SELECT COALESCE(MAX(seq), 0) + 1 FROM events), ?, ?)`,
          key,
          event
        )
      for (const [thread, parent, depth] of claims) {
        insert(
          `thread:requested:ag.${thread}`,
          `{"type":"ThreadRequested","thread":"ag.${thread}"${parent === undefined ? "" : `,"parentThread":"ag.${parent}"`},"depth":${depth},"at":1}`
        )
        insert(`thread:registered:ag.${thread}`, `{"type":"ThreadRegistered","thread":"ag.${thread}","at":2}`)
      }
      for (const [key, event] of extra) insert(key, event)
    })
  }

  test("a bounded tree read never builds what it does not return", async () => {
    // A wide root with four leaves, a deep chain four levels down, and a claim pair at its bottom
    // whose second edge points back at itself. The pair's edges live in the claiming thread's own
    // record, so no root path reaches it and the unbounded read fails its completeness check
    // rather than answering (worker.ts, threadTreeOf). A bounded read that answers therefore
    // proves the walk never built what the bounds exclude. The second claim of loop-a rides
    // unkeyed rows, because its request and registration keys are spent on the first.
    await claimTree("tree-bounds", [
      ["wide-root", undefined, 0],
      ["deep-0", undefined, 0],
      ["leaf-1", "wide-root", 1],
      ["leaf-2", "wide-root", 1],
      ["leaf-3", "wide-root", 1],
      ["leaf-4", "wide-root", 1],
      ["deep-1", "deep-0", 1],
      ["deep-2", "deep-1", 2],
      ["deep-3", "deep-2", 3],
      ["deep-4", "deep-3", 4],
      ["loop-a", "deep-4", 5],
      ["loop-b", "loop-a", 6]
    ], [
      [null, `{"type":"ThreadRequested","thread":"ag.loop-a","parentThread":"ag.loop-b","depth":7,"at":3}`],
      [null, `{"type":"ThreadRegistered","thread":"ag.loop-a","at":4}`]
    ])
    const directory = (env as Env).ACTORS.getByName(JSON.stringify(["echo", "tree-bounds"]))
    const nodeOf = (nodes: ReadonlyArray<ActorThreadNode>, id: string): ActorThreadNode | undefined => {
      for (const node of nodes) {
        if (node.id === id) return node
        const found = nodeOf(node.children, id)
        if (found !== undefined) return found
      }
      return undefined
    }
    const idsOf = (nodes: ReadonlyArray<ActorThreadNode>): ReadonlyArray<string> =>
      nodes.flatMap((node) => [node.id, ...idsOf(node.children)])
    const depthTwo = (await directory.threadTree({ maxDepth: 2 }))!
    // The wide root keeps its four leaves, and the deep chain stops at its second level.
    expect(nodeOf(depthTwo, "wide-root")?.children.map((node) => node.id))
      .toEqual(["leaf-1", "leaf-2", "leaf-3", "leaf-4"])
    expect(nodeOf(depthTwo, "deep-0")?.children.map((node) => node.id)).toEqual(["deep-1"])
    expect(nodeOf(depthTwo, "deep-1")?.children.map((node) => node.id)).toEqual(["deep-2"])
    expect(nodeOf(depthTwo, "deep-2")?.children).toEqual([])
    expect(idsOf(depthTwo).some((id) => id === "deep-3" || id === "loop-a" || id === "loop-b")).toBe(false)
    // The node budget runs out inside the chain, and the walk stops before wide-root entirely.
    const budgetFour = (await directory.threadTree({ maxNodes: 4 }))!
    expect(idsOf(budgetFour)).toEqual(["deep-0", "deep-1", "deep-2", "deep-3"])
    expect(nodeOf(budgetFour, "deep-3")?.children).toEqual([])
    // A stated root builds only its subtree, and the pair that walk never started on is absent.
    const rooted = (await directory.threadTree({ root: "wide-root" }))!
    expect(idsOf(rooted)).toEqual(["wide-root", "leaf-1", "leaf-2", "leaf-3", "leaf-4"])
    // The unbounded read is a throw, not an answer: its completeness check reaches the pair.
    // The three reads above read the same roster, so each walk that answered is proof the bounds
    // held it.
    const unbounded = await directory.threadTree().then(
      () => "answered",
      (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
    )
    expect(unbounded).toBe("thread tree contains an orphan or cycle")
  })

  test("the threads route carries the bounds and refuses what cannot count", async () => {
    const client = makeActorClient({ baseUrl: "http://test", token: "workers-test-token", fetch: (input, init) => SELF.fetch(input, init) })
    const directory = (env as Env).ACTORS.getByName(JSON.stringify(["echo", "tree-route"]))
    await directory.init("echo", "tree-route")
    const wide = await directory.createThread("wide-root")
    const leaf1 = await directory.createThread("leaf-1", { parent: wide.thread })
    const leaf2 = await directory.createThread("leaf-2", { parent: wide.thread })
    const deep = await directory.createThread("deep-0")
    const deep1 = await directory.createThread("deep-1", { parent: deep.thread })
    const deep2 = await directory.createThread("deep-2", { parent: deep1.thread })
    const read = async (query: string) =>
      await SELF.fetch(`http://test/v1/actors/tree-route/threads${query}`, { headers: authorization })
    const depthOne = await client.list("tree-route", { maxDepth: 1 })
    expect(depthOne.map((node) => node.id)).toEqual([deep.thread, deep1.thread, wide.thread, leaf1.thread, leaf2.thread])
    expect(depthOne.some((node) => node.id === deep2.thread)).toBe(false)
    const rooted = await client.list("tree-route", { root: wide.thread })
    expect(rooted.map((node) => node.id)).toEqual([wide.thread, leaf1.thread, leaf2.thread])
    expect((await read("?root=ghost")).status).toBe(404)
    expect((await read("?maxDepth=-1")).status).toBe(400)
    expect((await read("?maxNodes=0")).status).toBe(400)
    expect((await read("?maxNodes=many")).status).toBe(400)
  })

  test("a re-delivery to a registered child delivers instead of recreating", async () => {
    const directory = controlStub()
    await directory.init("echo", "main")
    await directory.createThread("ag.re-delivery-parent")
    const parent = { actor: "echo", instance: "main", thread: "ag.re-delivery-parent" }
    const target = { actor: "echo", instance: "main", thread: "ag.re-delivery-child" }
    await directory.allocateThread({ kind: "child", parent, child: childKeyOf(target.thread) })
    const lineage = { parent, depth: 1, placement: "independent" as const }
    await directory.deliverChild({
      link: { source: parent, target },
      event: { type: "MessageReceived", id: "re-delivery-first", text: "hello", at: 2 },
      lineage
    })
    let tree = await directory.threadTree()
    const delay = (): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, 10)
      return promise
    }
    for (let attempt = 0; attempt < 100 && !tree.some((node) => node.id === "re-delivery-child"); attempt++) {
      await delay()
      tree = await directory.threadTree()
    }
    await directory.deliverChild({
      link: { source: parent, target },
      event: { type: "MessageReceived", id: "re-delivery-second", text: "again", at: 3 },
      lineage
    })
    const childEvents = await threadStub("ag.re-delivery-child").events("ag.re-delivery-child")
    expect(childEvents.map((event) => event.type)).toEqual(["ThreadCreated", "MessageReceived", "MessageReceived"])
    let childStatus = await threadStub("ag.re-delivery-child").status()
    for (let attempt = 0; attempt < 100; attempt++) {
      if (childStatus.dirty === 0 && childStatus.status === "resting") break
      await delay()
      childStatus = await threadStub("ag.re-delivery-child").status()
    }
    expect(childStatus).toMatchObject({ dirty: 0, status: "resting" })
  }, WORKER_INTEGRATION_TIMEOUT_MILLIS)

  test("actor supervisor alarm completes a staged child", async () => {
    const directory = controlStub()
    await directory.init("echo", "main")
    await directory.createThread("ag.recovery-parent")
    const parent = { actor: "echo", instance: "main", thread: "ag.recovery-parent" }
    const target = { actor: "echo", instance: "main", thread: "ag.recovery-child" }
    const lineage = { parent, depth: 1, placement: "independent" as const }
    const child = threadStub("ag.recovery-child")
    await child.init("echo", "main", "ag.recovery-child")
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
    await child.provision({ type: "ThreadCreated", address: target, ...lineage, at: 4 })
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


test("HTTP allocation preserves unnamed keys and creates nested children", async () => {
  await createThread("sdk-parent")
  const allocate = async (input: { readonly name?: string; readonly key?: string; readonly parent?: string }) => {
    const response = await SELF.fetch("http://test/v1/actors/main/threads", {
      method: "POST", headers: { ...authorization, "content-type": "application/json" }, body: JSON.stringify(input)
    })
    expect(response.status).toBe(200)
    return await response.json() as { readonly actor: string; readonly instance: string; readonly thread: string }
  }
  const first = await allocate({ key: "sdk-stable" })
  expect(await allocate({ key: "sdk-stable" })).toEqual(first)
  const child = await allocate({ name: "sdk-child", parent: "sdk-parent" })
  const grandchild = await allocate({ name: "sdk-grandchild", parent: child.thread })
  expect(await allocate({ name: "sdk-grandchild", parent: child.thread })).toEqual(grandchild)
  const accepted = await SELF.fetch(`http://test/v1/actors/main/threads/${grandchild.thread}/methods/echo`, {
    method: "POST", headers: { ...authorization, "content-type": "application/json", "Idempotency-Key": "sdk-nested" }, body: JSON.stringify({ text: "hello" })
  })
  expect(accepted.status).toBe(202)
  expect(accepted.headers.get("Location")).toContain("/calls/sdk-nested?")
  expect((await SELF.fetch(new URL(accepted.headers.get("Location")!, "http://test"), { headers: authorization })).status).toBe(200)
  expect(await methodState(grandchild.thread, "sdk-nested")).toMatchObject({ status: "completed" })
  const client = makeActorClient({ baseUrl: "http://test", token: "workers-test-token", fetch: (input, init) => SELF.fetch(input, init) })
  const listed = await client.list("main", { root: "sdk-parent" })
  expect(listed.map(({ id, parent, depth }) => ({ id, parent, depth }))).toEqual([
    { id: "sdk-parent", parent: undefined, depth: 0 },
    { id: child.thread, parent: "sdk-parent", depth: 1 },
    { id: grandchild.thread, parent: child.thread, depth: 2 }
  ])
  expect(listed.at(-1)).toMatchObject({ events: 3, status: "settled", lastAt: expect.any(Number) })
  expect((await client.list("main", { root: "sdk-parent", maxDepth: 1 })).map(({ id }) => id)).toEqual(["sdk-parent", child.thread])
  expect((await client.list("main", { root: "sdk-parent", maxNodes: 1 })).map(({ id }) => id)).toEqual(["sdk-parent"])
}, WORKER_INTEGRATION_TIMEOUT_MILLIS)


test("rejects remounting without replacing the actor", () => {
  const original = mountedActor
  expect(original).toBeDefined()
  for (const name of ["echo", "other"]) {
    const definition = actor({ name, methods: {}, components: [] })
    expect(() => createWorker(definition)).toThrow('Worker already hosts actor "echo"; call defineWorkerHost once per module')
    expect(() => cloudflareWorker(definition)).toThrow('Worker already hosts actor "echo"; call defineWorkerHost once per module')
    expect(mountedActor).toBe(original)
  }
})
