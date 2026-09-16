import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { withWatermark } from "@clavia/tardigrade-core/log"
import { Self } from "@clavia/tardigrade-core/runtime"
import { Router } from "@clavia/tardigrade-core/transport/router"
import { prepareInvocation } from "@clavia/tardigrade-core/interaction/prepare"
import { threadCreated } from "@clavia/tardigrade-core/interaction/relations"
import { childKeyOf } from "@clavia/tardigrade-core/actor/coordinate"
import { ThreadProvisioner, threadSupervisor } from "@clavia/tardigrade-core/actor/supervisor"
import { threadSupervisorDriver, threadSupervisorKeyOf } from "./thread-supervisor"
import { createHost } from "./host"

const target = { actor: "test", instance: "main", thread: "root" }

test("child allocation preserves valid lineage and refuses invalid requests without side effects", async () => {
  const setups: string[] = []
  const host = createHost({ actorName: "test", actorInstance: "main", actorFor: () => undefined,
    supervisor: threadSupervisor({ setup: ({ target, request }) => Effect.sync(() => {
      if (request.kind === "child") {
        expect(host.read(target.thread)[0]).toMatchObject({ parent: request.parent, maxDepth: request.maxDepth })
      }
      setups.push(target.thread)
    }) })
  })
  host.seed(target.thread, [{ ...threadCreated(target, undefined, 0), maxDepth: 3 }])
  await host.allocate({ kind: "root", coordinate: target })
  for (const maxDepth of [0, 4]) {
    await expect(host.allocate({ kind: "child", parent: target, child: childKeyOf("child"), maxDepth })).rejects.toThrow("invalid lineage")
    expect(host.read("child")).toEqual([])
  }
  expect(setups).toEqual([target.thread])
  for (const maxDepth of [undefined, 2]) {
    const name = maxDepth === undefined ? "inherited" : "restricted"
    const request = { kind: "child" as const, parent: target, child: childKeyOf(name),
      ...(maxDepth === undefined ? {} : { maxDepth }) }
    const child = await host.allocate(request)
    const lineage = { parent: target, depth: 1, maxDepth: maxDepth ?? 3 }
    expect(host.read(child.thread)).toEqual([expect.objectContaining({ type: "ThreadCreated", address: child, ...lineage })])
    await host.commit({ link: { source: target, target: child }, lineage, event: { type: "MessageReceived", id: "m", at: 1 } })
    const committed = host.read(child.thread)
    expect(await host.allocate(request)).toEqual(child)
    await expect(host.allocate({ ...request, maxDepth: maxDepth === undefined ? 2 : 3 })).rejects.toThrow("different lineage")
    expect(host.read(child.thread)).toEqual(committed)
    expect(setups.filter((thread) => thread === child.thread)).toEqual([child.thread])
  }
})

test("typed supervisor requests share durable effect completion across concurrent callers and recovery", async () => {
  const events: Event[] = []
  let attempts = 0
  let failCommit = true
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const actor = threadSupervisor({ setup: () => Effect.promise(async () => { attempts++; started.resolve(); await release.promise }) })
  const log = withWatermark({
    read: Effect.succeed(events),
    append: (batch) => Effect.sync(() => {
      if (failCommit && batch.some((event) => event.type === "ThreadRegistered")) throw new Error("commit failed")
      for (const event of batch) {
        const key = threadSupervisorKeyOf(actor, event)
        if (key === undefined || !events.some((old) => threadSupervisorKeyOf(actor, old) === key)) events.push(event)
      }
    })
  })
  const open = () => threadSupervisorDriver(actor, log, Layer.succeed(ThreadProvisioner, {
    create: () => Effect.succeed(threadCreated(target, undefined, 0)),
    register: () => Effect.void
  }), (operation) => Effect.runPromise(operation.pipe(
    Effect.provideService(Self, target),
    Effect.provideService(Router, { send: () => Effect.die(new Error("unexpected routing")) })
  )))
  const driver = open()
  const request = { kind: "root" as const, coordinate: target }
  events.push(prepareInvocation({ reference: { target, invocation: { method: "requestThread", id: target.thread, epoch: 0 } }, method: actor.methods.requestThread, input: { target, request }, at: 0 }).event)
  const first = driver.ensureReady(target).catch((error: unknown) => error)
  await started.promise
  expect(events.map((event) => event.type)).toEqual(["ThreadRequested"])
  release.resolve()
  expect(await first).toBeInstanceOf(Error)
  failCommit = false
  const recovered = open()
  await Promise.all([recovered.ensureReady(target), recovered.ensureReady({ thread: "root", instance: "main", actor: "test" })])
  expect(attempts).toBe(2)
  expect(events.map((event) => event.type)).toEqual(["ThreadRequested", "ThreadRegistered"])
  expect(events.find((event) => event.type === "ThreadRegistered")?.transitionRef).toBeDefined()
  await open().ensureReady(target)
  expect(attempts).toBe(2)
})

test("allocation gates delivery and reuses completed identity", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let attempts = 0
  const host = createHost({ actorName: "test", actorInstance: "main", actorFor: () => undefined,
    supervisor: threadSupervisor({ setup: () => Effect.promise(async () => { attempts++; started.resolve(); await release.promise }) })
  })
  await expect(host.commitRoot(host.self("root"), { type: "MessageReceived", id: "missing", at: 1 })).rejects.toThrow("allocate it before delivery")
  expect(host.read("root")).toEqual([])
  expect(attempts).toBe(0)
  let assigned = false
  const allocation = host.assignThread({ kind: "root", coordinate: { thread: "root", instance: "main", actor: "test" } }).then((coordinate) => {
    assigned = true
    return coordinate
  })
  await started.promise
  const deliver = () => host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m", text: "work", at: 1 })
  await expect(deliver()).rejects.toThrow("allocate it before delivery")
  expect(assigned).toBe(false)
  expect(host.read("root").map((event) => event.type)).toEqual(["ThreadCreated"])
  release.resolve()
  expect(await allocation).toEqual(target)
  await deliver()
  const committed = host.read("root")
  expect(await host.allocate({ kind: "root", coordinate: target })).toEqual(target)
  expect(host.read("root")).toEqual(committed)
  expect(attempts).toBe(1)
  expect(host.read("root").some((event) => event.type === "MessageReceived")).toBe(true)
})

test("every memory creation entry point consults the allocator before setup", async () => {
  let setups = 0
  const host = createHost({ actorName: "test", actorInstance: "main", actorFor: () => undefined,
    supervisor: threadSupervisor({ setup: () => Effect.sync(() => { setups++ }) }),
    threadAllocator: { allocate: () => Effect.die(new Error("allocation refused")) }
  })
  const child = { ...target, thread: "child" }
  const parent = { ...target, thread: "parent" }
  host.seed(parent.thread, [threadCreated(parent, undefined, 0)])
  const lineage = { parent, depth: 1, maxDepth: 2 }
  const root = { kind: "root" as const, coordinate: target }
  for (const operation of [
    () => host.allocate(root),
    () => host.assignThread(root),
    () => host.allocate({ kind: "child", parent, child: childKeyOf(child.thread), maxDepth: 2 })
  ]) {
    await expect(operation()).rejects.toThrow("allocation refused")
    expect(host.read(target.thread)).toEqual([])
    expect(host.read(child.thread)).toEqual([])
    expect(setups).toBe(0)
  }
  await expect(host.commitRoot(host.self(target.thread), { type: "MessageReceived", id: "m", at: 1 })).rejects.toThrow("allocate it before delivery")
  await expect(host.commit({ link: { source: parent, target: child }, lineage, event: { type: "MessageReceived", id: "m", at: 1 } })).rejects.toThrow("allocate it before delivery")
  host.seed(target.thread, [threadCreated(target, undefined, 0)])
  await expect(host.forkThread({ source: target.thread, seq: 1, name: "fork" })).rejects.toThrow("allocation refused")
  expect(host.read(child.thread)).toEqual([])
  expect(host.read("fork")).toEqual([])
  expect(setups).toBe(0)
})

test("fork setup sees complete history and recovery preserves the published log", async () => {
  let failed = true
  const setupLogs: ReadonlyArray<Event>[] = []
  const host = createHost({ actorName: "test", actorInstance: "main", actorFor: () => undefined,
    supervisor: threadSupervisor({ setup: ({ target, request }) => Effect.sync(() => {
      if (request.kind !== "root" || request.fork === undefined) return
      setupLogs.push(host.read(target.thread))
      if (failed) throw new Error("setup failed")
    }) })
  })
  await host.allocate({ kind: "root", coordinate: target })
  await host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m", at: 1 })
  const request = { source: "root", seq: 2, name: "fork" }
  await expect(host.forkThread(request)).rejects.toThrow("setup failed")
  const published = host.read("fork")
  expect(published.map((event) => event.type)).toEqual(["ThreadCreated", "MessageReceived", "ThreadForked"])
  expect(published[1]).toEqual(host.read("root")[1])
  expect(setupLogs).toEqual([published])
  failed = false
  await host.forkThread(request)
  await host.forkThread(request)
  expect(host.read("fork")).toEqual(published)
  expect(setupLogs).toEqual([published, published])
  await expect(host.forkThread({ ...request, seq: 1 })).rejects.toThrow("already has a log that is not this fork")
  expect(host.read("fork")).toEqual(published)
  expect(setupLogs).toEqual([published, published])
})
