import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { defineActor, threadTarget, bindThreadMethods, allocateChildThread, allocateRootThread, legacyComponent } from "@clavia/tardigrade-core/actor"
import { legacyActorMethod } from "@clavia/tardigrade-core/actor/method-compat"
import { methodIngressKeyOf } from "@clavia/tardigrade-core/interaction/invocation"
import { prepareInvocation } from "@clavia/tardigrade-core/interaction"
import { effect } from "@clavia/tardigrade-core/effect"
import { intent } from "@clavia/tardigrade-core/intent"
import type { Event } from "@clavia/tardigrade-core/event"
import { actorRuntimeOf } from "@clavia/tardigrade-core/runtime"
import { createHost } from "./host"
import { memoryThreadDirectory, registeredThreadAllocator } from "./allocation"

test("unnamed allocation positions separate actions and invocation coordinates and repeat on replay", async () => {
  const tardie = defineActor("test", {}, [])
  const cases = [
    { method: "run", id: "a", epoch: 0, action: "first" },
    { method: "run", id: "a", epoch: 0, action: "second" },
    { method: "other", id: "a", epoch: 0, action: "first" },
    { method: "run", id: "b", epoch: 0, action: "first" },
    { method: "run", id: "a", epoch: 1, action: "first" }
  ]
  const component = legacyComponent({
    name: "allocation",
    keys: { prefixes: ["allocated:"], keyOf: (event: Event) => event.type === "Allocated" ? String(event.key) : undefined },
    derive: () => ({ view: undefined, transitions: cases.map(({ action, ...invocation }) => {
      const key = `allocated:${JSON.stringify([invocation, action])}`
      return effect({ key, invocation, input: undefined, act: () => Effect.gen(function* () {
        const first = yield* tardie.allocateRootThread({ instance: "main" })
        const second = yield* tardie.allocateRootThread({ instance: "main" })
        const explicit = yield* tardie.allocateRootThread({ instance: "main", key: "chosen" })
        const repeated = yield* tardie.allocateRootThread({ instance: "main", key: "chosen" })
        expect(repeated.address).toEqual(explicit.address)
        return [{ type: "Allocated", key, threads: [first.address.thread, second.address.thread, explicit.address.thread] }]
      }) })
    }) })
  })
  const actor = defineActor("test", {}, [component])
  const assignments = memoryThreadDirectory()
  const run = async () => {
    const host = createHost({ actorName: "test", actorInstance: "main",
      actorFor: (thread) => thread === "caller" ? actor : undefined,
      keyOf: actorRuntimeOf(actor).keyOf,
      threadAllocator: registeredThreadAllocator(assignments) })
    await host.commitRoot(host.self("caller"), { type: "MessageReceived", id: "start", at: 0 })
    await host.drive()
    return host.read("caller").filter((event) => event.type === "Allocated").map((event) => event.threads as string[])
  }
  const first = await run()
  expect(first).toHaveLength(cases.length)
  expect(new Set(first.flat()).size).toBe(cases.length * 3)
  expect(await run()).toEqual(first)
})

for (const placement of ["existing", "child", "root"] as const) test(`typed calls to ${placement} threads release a single host slot and replay without redispatch`, async () => {
  const research = legacyActorMethod({
    input: Schema.Struct({ topic: Schema.String }), output: Schema.String,
    event: ({ invocation, input, at }): Event => ({ type: "ResearchRequested", id: invocation.id, topic: input.topic, at }),
    state: (events, invocation) => {
      const done = events.find((event) => event.type === "ResearchCompleted" && event.id === invocation.id)
      return done === undefined ? { status: "pending" } : { status: "completed", output: String(done.output) }
    }
  })
  const summarize = legacyActorMethod({
    input: Schema.Struct({}), output: Schema.String,
    event: ({ invocation, at }): Event => ({ type: "SummaryRequested", id: invocation.id, at }),
    state: (events, invocation) => {
      const done = events.find((event) => event.type === "SummaryCompleted" && event.id === invocation.id)
      return done === undefined ? { status: "pending" } : { status: "completed", output: String(done.output) }
    }
  })
  const methods = { research, summarize }
  const worker = bindThreadMethods(threadTarget({ name: "test", methods }, "main", "worker"))
  let workerThread = "worker"
  let responsesReady = placement !== "child"
  let attempts = 0
  const parent = legacyComponent({
    name: "parent",
    keys: { prefixes: ["summary:"], keyOf: (event) => event.type === "SummaryCompleted" ? `summary:${String(event.id)}` : undefined },
    derive: (events) => {
      const request = events.find((event) => event.type === "SummaryRequested")
      return { view: undefined, transitions: request === undefined ? [] : [effect({
        key: `summary:${String(request.id)}`,
        invocation: { method: "summarize", id: String(request.id), epoch: 0 },
        input: request,
        act: () => Effect.gen(function* () {
          attempts++
          const ref = placement === "existing" ? worker : placement === "root"
            ? yield* allocateRootThread({ name: "test", methods }, { instance: "main", name: "worker" })
            : yield* allocateChildThread({ name: "test", methods }, {
            parent: threadTarget({ name: "test", methods }, "main", "root"), name: "worker"
          })
          workerThread = ref.address.thread
          const first = yield* ref.research({ topic: "energy" }, { key: "first" })
          const second = yield* ref.research({ topic: "safety" }, { key: "second" })
          return [{ type: "SummaryCompleted", id: request.id, output: `${first}; ${second}` }]
        }).pipe(Effect.orDie)
      })] }
    }
  })
  const child = legacyComponent({
    name: "worker",
    keys: { prefixes: ["research:"], keyOf: (event) => event.type === "ResearchCompleted" ? `research:${String(event.id)}` : undefined },
    derive: (events) => ({ view: undefined, transitions: events.filter((event) => responsesReady && event.type === "ResearchRequested").map((event) => intent({
      key: `research:${String(event.id)}`, input: event,
      events: (input) => [{ type: "ResearchCompleted", id: input.id, output: input.topic }]
    })) })
  })
  const definition = defineActor("test", methods, [parent, child])
  const assignments = memoryThreadDirectory()
  const open = () => createHost({
    threadAllocator: registeredThreadAllocator(assignments),
    actorName: "test", actorInstance: "main", actorFor: () => definition,
    keyOf: (event) => methodIngressKeyOf(event) ?? actorRuntimeOf(definition).keyOf(event),
    driver: { maxConcurrentThreads: 1 }
  })
  let host = open()
  if (placement === "existing") await host.commitRoot(host.self("worker"), { type: "MessageReceived", id: "ready", at: Date.now() })
  const event = prepareInvocation({
    reference: { target: { actor: "test", instance: "main", thread: "root" }, invocation: { method: "summarize", id: "summary", epoch: 0 } },
    method: summarize, input: {}, at: Date.now()
  }).event
  await host.commitRoot(host.self("root"), event)
  await host.drive()
  if (placement === "child") {
    expect(host.read("root").some((event) => event.type === "SummaryCompleted")).toBe(false)
    const parentLog = host.read("root")
    const childLog = host.read(workerThread)
    host = open()
    host.seed("root", parentLog)
    host.seed(workerThread, childLog)
    responsesReady = true
    await host.wake(workerThread)
  }
  expect(host.read("root").find((event) => event.type === "SummaryCompleted")?.output).toBe("energy; safety")
  expect(host.read(workerThread).filter((event) => event.type === "ResearchRequested")).toHaveLength(2)
  expect(attempts).toBeGreaterThan(2)
  await host.drive()
  expect(host.read(workerThread).filter((event) => event.type === "ResearchRequested")).toHaveLength(2)
})
