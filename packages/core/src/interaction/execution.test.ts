import { expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { defineActor } from "../actor/definition"
import { bindThreadMethods, threadTarget } from "../actor/reference"

import { legacyActorMethod } from "../actor/method-compat"
import { actorCall } from "./invoke"
import { EventLog, withWatermark } from "../log"
import { Router } from "../transport/router"
import { Self } from "../runtime/context"
import { InvocationScope, InvocationFailed, InvocationCancelled } from "./execution"
import { actorOperations } from "./execution"
import { ThreadAllocator } from "../actor/allocation"
import { formatThreadAddress } from "../transport/endpoint"
import type { Event } from "../event"

const research = legacyActorMethod({
  input: Schema.Struct({ topic: Schema.String }), output: Schema.String,
  event: ({ invocation, input, at }): Event => ({ type: "ResearchRequested", id: invocation.id, topic: input.topic, at }),
  state: () => ({ status: "pending" })
})
const count = legacyActorMethod({
  input: Schema.Struct({ items: Schema.Array(Schema.String) }), output: Schema.FiniteFromString,
  event: ({ invocation, input, at }): Event => ({ type: "CountRequested", id: invocation.id, items: input.items, at }),
  state: () => ({ status: "pending" })
})
const definition = defineActor("scientist", { research, count }, [])
const reference = bindThreadMethods(threadTarget(definition, "main", "worker"))
const parent = { target: { actor: "scientist", instance: "main", thread: "root" }, invocation: { method: "review", id: "parent", epoch: 0 } }

export const threadRefTypes = () => [
  // @ts-expect-error research accepts its declared input
  reference.methods.research({ items: [] }, { key: "review" }),
  // @ts-expect-error callers must provide a stable key
  reference.count({ items: [] }),
  // @ts-expect-error undeclared methods are absent
  reference.message({}, { key: "review" })
]

test("allocation binds only declared method types and does not execute calls", async () => {
  const ref = await Effect.runPromise(definition.allocateRootThread({ instance: "main", name: "worker" }).pipe(
    Effect.provideService(ThreadAllocator, { allocate: (request) => Effect.succeed(request.kind === "root" ? request.coordinate : request.parent) })
  ))
  expect(typeof ref.research).toBe("function")
  expect(typeof ref.count).toBe("function")
  expect(ref.coordinate).toEqual({ actor: "scientist", instance: "main", thread: "worker" })
  expect(ref.address).toBe(ref.coordinate)
  expect(ref).not.toHaveProperty("message")
  const output: Effect.Success<ReturnType<typeof ref.count>> = 3
  expect(output).toBe(3)
})

test("completed, failed, and cancelled replies retain their typed outcomes", async () => {
  const options = { parent, key: "review", target: reference, method: "research" as const, input: { topic: "energy" } }
  const call = actorCall([], options)
  const planning = call.transitions[0]!
  if (planning.kind !== "intent") throw new Error("expected plan")
  const planned = planning.events(planning.input, 0)
  const run = (outcome: Record<string, unknown>) => {
    const events: Event[] = [...planned, {
      type: "ResponseReceived", reference: call.reference, id: "reply", from: formatThreadAddress(reference.coordinate),
      method: "research", call: call.id, epoch: 0, at: 1, ...outcome
    }]
    return Effect.runPromise(reference.methods.research({ topic: "energy" }, { key: "review" }).pipe(
      Effect.provide(Layer.mergeAll(
        Layer.succeed(InvocationScope, { context: { invocation: parent.invocation }, signal: new AbortController().signal }),
        Layer.succeed(Self, parent.target),
        Layer.succeed(EventLog, withWatermark({ read: Effect.succeed(events), append: () => Effect.die("unexpected append") })),
        Layer.succeed(Router, { send: () => Effect.die("unexpected redispatch") })
      )),
      Effect.catchTags({
        InvocationFailed: (failure) => Effect.succeed(failure),
        InvocationCancelled: (failure) => Effect.succeed(failure)
      })
    ))
  }
  expect(await run({ status: "completed", output: "answer" })).toBe("answer")
  expect(await run({ status: "failed", error: "no energy" })).toBeInstanceOf(InvocationFailed)
  expect(await run({ status: "cancelled", cause: "requested" })).toBeInstanceOf(InvocationCancelled)
  expect(await run({ status: "completed", output: 123 })).toBeInstanceOf(InvocationFailed)
})

test("invoke and split operations decode transformed outputs once", async () => {
  const options = { parent, key: "count", target: reference, method: "count" as const, input: { items: ["a", "b", "c"] } }
  const call = actorCall([], options)
  const planning = call.transitions[0]!
  if (planning.kind !== "intent") throw new Error("expected plan")
  const events: Event[] = [...planning.events(planning.input, 0), {
    type: "ResponseReceived", reference: call.reference, id: "reply", from: formatThreadAddress(reference.coordinate),
    method: "count", call: call.id, epoch: 0, at: 1, status: "completed", output: "3"
  }]
  const layer = Layer.mergeAll(
    Layer.succeed(InvocationScope, { context: { invocation: parent.invocation }, signal: new AbortController().signal }),
    Layer.succeed(Self, parent.target),
    Layer.succeed(EventLog, withWatermark({ read: Effect.succeed(events), append: () => Effect.die("unexpected append") })),
    Layer.succeed(Router, { send: () => Effect.die("unexpected redispatch") })
  )
  const invoked = await Effect.runPromise(reference.methods.count({ items: ["a", "b", "c"] }, { key: "count" }).pipe(Effect.provide(layer)))
  const split = await Effect.runPromise(Effect.gen(function* () {
    const operations = actorOperations(reference, "count")
    const handle = yield* operations.start({ input: { items: ["a", "b", "c"] }, options: { key: "count" } })
    return yield* operations.await(handle)
  }).pipe(Effect.provide(layer)))
  expect(invoked).toBe(3)
  expect(split).toBe(3)
})

test("method namespaces preserve metadata and promise assimilation", async () => {
  for (const name of ["coordinate", "address", "methods", "then", "__proto__"]) {
    const ref = bindThreadMethods({ coordinate: parent.target, methods: { [name]: research } })
    expect(Object.keys(ref.methods)).toEqual([name])
    expect(typeof ref.methods[name]).toBe("function")
    expect(ref.coordinate).toEqual(parent.target)
    expect(ref.address).toBe(ref.coordinate)
    expect(await Promise.resolve(ref)).toBe(ref)
    expect(Object.hasOwn(ref, "then")).toBe(false)
  }
})

test("sibling transition owners isolate the same nested invocation key", () => {
  const firstOwner = { type: "transition" as const, ref: { seq: 12, component: "weather", tag: "fetch" } }
  const secondOwner = { type: "transition" as const, ref: { seq: 19, component: "weather", tag: "fetch" } }
  const call = (owner: typeof firstOwner) => actorCall([], {
    target: reference, method: "research", input: { topic: "weather" },
    parent, context: { invocation: parent.invocation }, key: "lookup", owner
  })
  const first = call(firstOwner)
  const second = call(secondOwner)
  expect(first.reference).not.toEqual(second.reference)
  expect(call(firstOwner).reference).toEqual(first.reference)
  const plan = first.transitions[0]!
  if (plan.kind !== "intent") throw new Error("expected invocation plan")
  expect(plan.events(plan.input, 1).find((event) => event.type === "InvocationLinked"))
    .toMatchObject({ owner: firstOwner, parent: parent.invocation })
})
