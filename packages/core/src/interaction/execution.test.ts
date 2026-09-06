import { expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { defineActor } from "../actor/definition"
import { bindThreadMethods, threadTarget } from "../actor/reference"

import { legacyActorMethod } from "../actor/method-compat"
import { actorCall } from "./invoke"
import { EventLog, withWatermark } from "../log"
import { Router } from "../transport/router"
import { Self } from "../runtime/reconciler"
import { InvocationScope, InvocationFailed, InvocationCancelled } from "./execution"
import { ThreadAllocator } from "../actor/allocation"
import { formatThreadAddress } from "../transport/endpoint"
import type { Event } from "../event"

const research = legacyActorMethod({
  input: Schema.Struct({ topic: Schema.String }), output: Schema.String,
  event: ({ invocation, input, at }): Event => ({ type: "ResearchRequested", id: invocation.id, topic: input.topic, at }),
  state: () => ({ status: "pending" })
})
const count = legacyActorMethod({
  input: Schema.Struct({ items: Schema.Array(Schema.String) }), output: Schema.Int,
  event: ({ invocation, input, at }): Event => ({ type: "CountRequested", id: invocation.id, items: input.items, at }),
  state: () => ({ status: "pending" })
})
const definition = defineActor("scientist", { research, count }, [])
const reference = bindThreadMethods(threadTarget(definition, "main", "worker"))
const parent = { target: { actor: "scientist", instance: "main", thread: "root" }, invocation: { method: "review", id: "parent", epoch: 0 } }

export const threadRefTypes = () => [
  // @ts-expect-error research accepts its declared input
  reference.research({ items: [] }, { key: "review" }),
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
      type: "ResponseReceived", reference: call.reference, id: "reply", from: formatThreadAddress(reference.address),
      method: "research", call: call.id, epoch: 0, at: 1, ...outcome
    }]
    return Effect.runPromise(reference.research({ topic: "energy" }, { key: "review" }).pipe(
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

test("reference metadata and promise assimilation names cannot be shadowed", () => {
  for (const name of ["address", "methods", "then"]) {
    expect(() => bindThreadMethods({ address: parent.target, methods: { [name]: research } })).toThrow("conflicts with the thread reference surface")
  }
})
