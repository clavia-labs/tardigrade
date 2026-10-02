import { expect, test } from "bun:test"
import { Context, Data, Effect, Layer } from "effect"
import type { Event } from "../event"
import { EventLog, withWatermark } from "../log"
import { prepareInvocation } from "../interaction/prepare"
import { threadCreated } from "../interaction/relations"
import { settleActor } from "../runtime/reconciler"
import { Self } from "../runtime/context"
import { Router } from "../transport/router"
import { ThreadProvisioner, threadCreationFor, threadSupervisor, type ThreadSupervisor } from "./supervisor"
import { childKeyOf } from "./coordinate"

const target = { actor: "test", instance: "main", thread: "root" }
const invocation = { method: "requestThread", id: "root", epoch: 0 }

const requested = (supervisor: ThreadSupervisor): Event => prepareInvocation({
  reference: { target, invocation }, method: supervisor.methods.requestThread,
  input: { target, request: { kind: "root", coordinate: target } }, at: 0
}).event

const settle = (supervisor: ThreadSupervisor, events: Event[], platform: Layer.Layer<ThreadProvisioner>) => Effect.runPromise(
  settleActor(supervisor).pipe(
    Effect.provide(platform),
    Effect.provideService(EventLog, withWatermark({
      read: Effect.succeed(events),
      append: (batch) => Effect.sync(() => { events.push(...batch) })
    })),
    Effect.provideService(Self, target),
    Effect.provideService(Router, { send: () => Effect.die(new Error("unexpected routing")) })
  )
)

test("supervisor uses the platform Layer when setup is omitted", async () => {
  const supervisor = threadSupervisor()
  const events = [requested(supervisor)]
  const steps: string[] = []
  const platform = Layer.succeed(ThreadProvisioner, {
    create: (input) => Effect.sync(() => { steps.push("create"); return threadCreated(input.target, undefined, 0) }),
    register: () => Effect.sync(() => { steps.push("register") })
  })
  expect(supervisor.methods.requestThread.state(events, invocation)).toEqual({ status: "pending" })
  await settle(supervisor, events, platform)
  expect(steps).toEqual(["create", "register"])
  expect(events.map((event) => event.type)).toEqual(["ThreadRequested", "ThreadRegistered"])
  expect(supervisor.methods.requestThread.state(events, invocation)).toEqual({ status: "completed", output: "root" })
  await settle(supervisor, events, platform)
  expect(steps).toEqual(["create", "register"])
})

test("supervisor recovers failed setup before registration and preserves completion", async () => {
  class SetupUnavailable extends Data.TaggedError("SetupUnavailable")<{ readonly message: string }> {}
  class Workspace extends Context.Service<Workspace, { readonly setup: Effect.Effect<void, SetupUnavailable> }>()("test/Workspace") {}
  const steps: string[] = []
  let fail = true
  let created = false
  let setupCompleted = false
  let registered = false
  const workspace = Layer.succeed(Workspace, {
    setup: Effect.gen(function* () {
      steps.push("setup")
      expect(created).toBe(true)
      if (fail) return yield* new SetupUnavailable({ message: "setup unavailable" })
      setupCompleted = true
    })
  })
  const supervisor = threadSupervisor({
    setup: () => Effect.gen(function* () { yield* (yield* Workspace).setup }).pipe(Effect.provide(workspace))
  })
  const events = [requested(supervisor)]
  const platform = Layer.succeed(ThreadProvisioner, {
    create: (input) => Effect.sync(() => { steps.push("create"); created = true; return threadCreated(input.target, undefined, 0) }),
    register: () => Effect.sync(() => { expect(setupCompleted).toBe(true); steps.push("register"); registered = true })
  })
  await expect(settle(supervisor, events, platform)).rejects.toThrow("setup unavailable")
  expect(registered).toBe(false)
  expect(supervisor.methods.requestThread.state(events, invocation)).toEqual({ status: "pending" })
  expect(events.map((event) => event.type)).toEqual(["ThreadRequested"])
  fail = false
  await settle(supervisor, events, platform)
  expect(registered).toBe(true)
  expect(supervisor.methods.requestThread.state(events, invocation)).toEqual({ status: "completed", output: "root" })
  expect(events.map((event) => event.type)).toEqual(["ThreadRequested", "ThreadRegistered"])
  const completedSteps = [...steps]
  await settle(supervisor, events, platform)
  expect(steps).toEqual(completedSteps)
})

test("supervisor creation preserves inherited child lineage", () => {
  const parent = { ...threadCreated(target, undefined, 0), maxDepth: 4 }
  const child = { ...target, thread: "child" }
  expect(threadCreationFor({ target: child, request: { kind: "child", parent: target, child: childKeyOf("child") } }, parent, "colocated", 1)).toMatchObject({ parent: target, maxDepth: 4, depth: 1, placement: "colocated" })
})

test("supervisor creation enforces the derived depth and inherited ceiling", () => {
  const parent = { ...threadCreated(target, undefined, 0), depth: 1, maxDepth: 3 }
  const input = { target: { ...target, thread: "child" }, request: { kind: "child" as const, parent: target, child: childKeyOf("child") } }
  for (const maxDepth of [0, 1, 4, 1.5, Infinity, NaN]) {
    expect(() => threadCreationFor({ ...input, request: { ...input.request, maxDepth } }, parent, undefined, 1)).toThrow("invalid lineage")
  }
  expect(threadCreationFor(input, parent, undefined, 1)).toMatchObject({ depth: 2, maxDepth: 3 })
  expect(threadCreationFor({ ...input, request: { ...input.request, maxDepth: 2 } }, parent, undefined, 1)).toMatchObject({ depth: 2, maxDepth: 2 })
})
