import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { actor } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/event"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import { Router } from "@clavia/tardigrade-core/transport/router"
import { threadAddressOf } from "@clavia/tardigrade-core/transport/endpoint"
import { Self, settleActor } from "@clavia/tardigrade-core/runtime"
import { definePackage } from "@clavia/tardigrade-code/package/definition"
import { guestBindings, Sandbox } from "@clavia/tardigrade-code/sandbox/service"
import { codeMode } from "../src/component/code/index"
import { tools } from "../src/component/tool/index"
import { budget } from "../src/component/budget/index"

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: ReadonlyArray<string>
) => (...bindings: ReadonlyArray<unknown>) => Promise<unknown>

test.each(["code", "tools"] as const)("%s honors a child's budget for concurrent method requests", async adapter => {
  const invoked: unknown[] = []
  const governed = budget(definePackage({
    name: "counter",
    description: "Counts admitted executions",
    methods: { run: value => Effect.sync(() => { invoked.push(value); return value }) }
  }), { limit: 1, usage: ({ calls }) => calls.length, onExhausted: (reason, respond) => respond({ error: reason }) })
  const definition = actor({ name: "package-budget", methods: {}, components: [adapter === "code" ? codeMode([governed]) : tools([governed])] })
  const log: Event[] = [
    { type: "MessageReceived", id: "turn", text: "Count", at: 0 },
    ...(adapter === "code"
      ? [{ type: "ToolCalled", turn: "turn", callId: "execute", name: "execute", arguments: { code: "return await Promise.all([counter.run(1), counter.run(2), counter.run(3)])" }, at: 1 }]
      : [1, 2, 3].map(value => ({ type: "ToolCalled", turn: "turn", callId: String(value), name: "counter_run", arguments: value, at: value })))
  ]
  const environment = Layer.mergeAll(
    KeyValueStore.layerMemory,
    Layer.succeed(Self, threadAddressOf("package-budget", "main", "root")),
    Layer.succeed(Router, { send: () => Effect.void }),
    Layer.succeed(EventLog, withWatermark({ read: Effect.sync(() => [...log]), append: events => Effect.sync(() => { log.push(...events) }) })),
    Layer.succeed(Sandbox, { run: (code, bindings) => Effect.promise(async () => {
      const scope = guestBindings(bindings)
      const names = Object.keys(scope)
      return { result: await new AsyncFunction(...names, code)(...names.map(name => scope[name])) }
    }) })
  )
  await Effect.runPromise(settleActor(definition).pipe(Effect.provide(environment)))
  expect(invoked).toEqual([1])
  const results = log.filter(event => event.type === "PackageReturned").map(event => event.result)
  expect(results).toHaveLength(3)
  expect(results.filter(result => (result as { error?: unknown })?.error !== undefined)).toHaveLength(2)
  expect(log.filter(event => event.type === "ToolReturned")).toHaveLength(adapter === "code" ? 1 : 3)
  const before = [...log]
  await Effect.runPromise(settleActor(definition).pipe(Effect.provide(environment)))
  expect(log).toEqual(before)
  expect(invoked).toEqual([1])
  log.push(
    { type: "TurnCompleted", turn: "turn", at: 10 },
    { type: "MessageReceived", id: "next", text: "Count again", at: 11 },
    { type: "ToolCalled", turn: "next", callId: "next", name: adapter === "code" ? "execute" : "counter_run", arguments: adapter === "code" ? { code: "return await counter.run(4)" } : 4, at: 12 }
  )
  await Effect.runPromise(settleActor(definition).pipe(Effect.provide(environment)))
  expect(invoked).toEqual([1, 4])
})
