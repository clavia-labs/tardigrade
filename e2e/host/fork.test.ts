import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { defineActor, bindThreadMethods, legacyComponent } from "@clavia/tardigrade-core/actor"
import { legacyActorMethod } from "@clavia/tardigrade-core/actor/method-compat"
import { actorRuntimeOf } from "@clavia/tardigrade-core/runtime"
import { effect } from "@clavia/tardigrade-core/effect"
import { prepareInvocation, callStateOf, replyStateOf, openChildInvocationsOf } from "@clavia/tardigrade-core/interaction"
import { isThreadForked } from "@clavia/tardigrade-core/log"
import { createBunHost } from "../../platform/bun/src/host"
import { createHost, hostBackend } from "../../platform/bun/src/create-host"
import type { Event } from "@clavia/tardigrade-core/event"

const address = (thread: string) => ({ actor: "fork-test", instance: "main", thread })
const work = legacyActorMethod({
  input: Schema.Struct({ next: Schema.optionalKey(Schema.String) }), output: Schema.String,
  event: ({ invocation, input, at }): Event => ({ type: "WorkStarted", id: invocation.id, next: input.next, at }),
  state: (events, invocation) => {
    const done = events.find((event) => event.type === "WorkFinished" && event.id === invocation.id)
    return done === undefined ? { status: "pending" } : { status: "completed", output: String(done.output) }
  }
})
const methods = { work }
const computation = legacyComponent({
  name: "work",
  keys: { prefixes: ["finished:"], keyOf: (event) => event.type === "WorkFinished" ? `finished:${String(event.id)}` : undefined },
  derive: (events) => ({ view: undefined, transitions: events.filter((event) => event.type === "WorkStarted" &&
    (typeof event.next === "string" || events.some((entry) => entry.type === "Released"))).map((request) => effect({
      key: `finished:${String(request.id)}`,
      invocation: { method: "work", id: String(request.id), epoch: 0 },
      input: request,
      act: () => Effect.gen(function* () {
        const output = typeof request.next === "string"
          ? yield* bindThreadMethods({ coordinate: address(request.next), methods }).work(
            request.next === "middle" ? { next: "leaf" } : {}, { key: "child" }
          ).pipe(Effect.catchTag("InvocationWasDetached", () => Effect.succeed("detached")))
          : "leaf-result"
        return [{ type: "WorkFinished", id: request.id, output }]
      }).pipe(Effect.orDie)
    })) })
})
const definition = defineActor("fork-test", methods, [computation])
const runtime = actorRuntimeOf(definition)

for (const restart of [false, true]) test(`forking a middle interaction detaches both directions${restart ? " across SQLite restart" : " before drive"}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fork-e2e-"))
  const open = () => createBunHost({ database: join(directory, "actor.sqlite"), actorName: "fork-test", actorInstance: "main",
    actorFor: () => runtime, driver: { maxConcurrentThreads: 1 } })
  let host = await open()
  try {
    for (const thread of ["root", "middle", "leaf"]) await host.allocate({ kind: "root", coordinate: address(thread) })
    await host.commitRoot(host.self("root"), prepareInvocation({
      reference: { target: address("root"), invocation: { method: "work", id: "root-call", epoch: 0 } },
      method: work, input: { next: "middle" }, at: Date.now()
    }).event)
    await host.drive()
    const originals = await Promise.all(["root", "middle", "leaf"].map((thread) => host.read(thread)))
    const middle = originals[1]!
    const incoming = middle.find((event) => event.type === "WorkStarted")!.call as { invocation: { method: string; id: string; epoch: number } }
    const outgoing = openChildInvocationsOf(middle)[0]!
    const incomingRef = { target: address("middle"), invocation: incoming.invocation }
    const outgoingRef = { target: address("leaf"), invocation: outgoing.child.invocation }
    expect(replyStateOf(middle, incomingRef).status).toBe("pending")
    expect(callStateOf(middle, outgoingRef).status).toBe("pending")
    const request = { source: "middle", seq: middle.length, name: "experiment" }
    await host.forkThread(request)
    const published = await host.read("experiment")
    expect(published.slice(-3).map((event) => event.type)).toEqual(["ThreadForked", "InvocationDetached", "InvocationDetached"])
    expect(published.filter((event) => event.type === "InvocationDetached").map((event) => event.direction).sort()).toEqual(["incoming", "outgoing"])
    expect(await Promise.all(["root", "middle", "leaf"].map((thread) => host.read(thread)))).toEqual(originals)
    if (restart) {
      await host.close()
      host = await open()
      expect(await host.read("experiment")).toEqual(published)
      await host.recover()
    } else await host.drive()
    const experiment = await host.read("experiment")
    expect(experiment.find((event) => event.type === "WorkFinished")?.output).toBe("detached")
    expect(experiment.some((event) => event.type === "ResponseDelivered")).toBe(false)
    expect(experiment.filter((event) => event.type === "CallDispatched")).toHaveLength(middle.filter((event) => event.type === "CallDispatched").length)
    expect(replyStateOf(experiment, incomingRef).status).toBe("detached")
    expect(callStateOf(experiment, outgoingRef).status).toBe("detached")
    expect(await Promise.all(["root", "middle", "leaf"].map((thread) => host.read(thread)))).toEqual(originals)
    expect(await host.forkThread(request)).toEqual(address("experiment"))
    expect(await host.read("experiment")).toEqual(experiment)
    const secondRequest = { source: "experiment", seq: published.length, name: "second" }
    await host.forkThread(secondRequest)
    await host.drive()
    const second = await host.read("second")
    expect(second.filter(isThreadForked).map((event) => [event.source.thread, event.destination])).toEqual([
      ["middle", "experiment"], ["experiment", "second"]
    ])
    expect(await host.forkThread(secondRequest)).toEqual(address("second"))
    expect(await host.read("second")).toEqual(second)
    expect(second.filter((event) => event.type === "InvocationDetached")).toHaveLength(2)
    expect(second.find((event) => event.type === "WorkFinished")?.output).toBe("detached")
    await host.commitRoot(host.self("leaf"), { type: "Released", at: Date.now() })
    await host.drive()
    for (const thread of ["root", "middle", "leaf"]) {
      const events = await host.read(thread)
      expect(events.find((event) => event.type === "WorkFinished")?.output).toBe("leaf-result")
      expect(events.some((event) => event.type === "InvocationDetached")).toBe(false)
    }
    const completedMiddle = await host.read("middle")
    expect(replyStateOf(completedMiddle, incomingRef).status).toBe("sent")
    expect(callStateOf(completedMiddle, outgoingRef).status).toBe("received")
    expect((await host.read("leaf")).filter((event) => event.type === "WorkStarted")).toHaveLength(1)
    expect(await host.read("experiment")).toEqual(experiment)
    expect(await host.read("second")).toEqual(second)
  } finally {
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)

test("the public host schedules a fork without additional ingress", async () => {
  const storage = await mkdtemp(join(tmpdir(), "fork-public-e2e-"))
  const host = await createHost({ actor: definition, storage, driver: { maxConcurrentThreads: 1 } })
  try {
    for (const name of ["root", "middle", "leaf"]) await host.allocateRootThread({ instance: "main", name })
    const backend = hostBackend(host)
    const instance = await backend.ensure("main")
    await backend.submit(address("root"), "work", { next: "middle" }, { key: "root" })
    await instance.settled()
    const middle = await instance.read("middle")
    expect(openChildInvocationsOf(middle)).toHaveLength(1)
    await host.forkThread({ source: "middle", seq: middle.length, name: "experiment" })
    await instance.settled()
    const events = await instance.read("experiment")
    expect(events.find((event) => event.type === "WorkFinished")?.output).toBe("detached")
    expect(events.filter((event) => event.type === "InvocationDetached")).toHaveLength(2)
    expect(events.some((event) => event.type === "ResponseDelivered")).toBe(false)
  } finally {
    await host.close()
    await rm(storage, { recursive: true, force: true })
  }
}, 20_000)
