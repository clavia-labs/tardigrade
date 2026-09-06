import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { defineActor, actorRef, bindThreadMethods, allocateChildThread, legacyComponent } from "@clavia/tardigrade-core/actor"
import { legacyActorMethod } from "@clavia/tardigrade-core/actor/method-compat"
import { methodIngressKeyOf } from "@clavia/tardigrade-core/interaction/invocation"
import { prepareInvocation } from "@clavia/tardigrade-core/interaction"
import { effect } from "@clavia/tardigrade-core/effect"
import { intent } from "@clavia/tardigrade-core/intent"
import type { Event } from "@clavia/tardigrade-core/event"
import { actorRuntimeOf } from "@clavia/tardigrade-core/runtime"
import { createHost } from "./host"

for (const placement of ["existing", "child"] as const) test(`typed calls to ${placement} threads release a single host slot and replay without redispatch`, async () => {
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
  const worker = bindThreadMethods(actorRef({ name: "test", methods }, "main", "worker"))
  let workerThread = "worker"
  let responsesReady = placement === "existing"
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
          const ref = placement === "existing" ? worker : yield* allocateChildThread({ name: "test", methods }, {
            parent: actorRef({ name: "test", methods }, "main", "root"), name: "worker"
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
  const open = () => createHost({
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
