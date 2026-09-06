import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import type { ThreadAllocation } from "@clavia/tardigrade-core/actor/allocation"
import { defineActor, legacyComponent } from "@clavia/tardigrade-core/actor"
import { legacyActorMethod } from "@clavia/tardigrade-core/actor/method-compat"
import { effect } from "@clavia/tardigrade-core/effect"
import { intent } from "@clavia/tardigrade-core/intent"
import type { Event } from "@clavia/tardigrade-core/event"
import { prepareInvocation, isActorEnvelope } from "@clavia/tardigrade-core/interaction"
import { methodIngressKeyOf } from "@clavia/tardigrade-core/interaction/invocation"
import { actorRuntimeOf } from "@clavia/tardigrade-core/runtime"
import { mappedDirectory } from "@clavia/tardigrade-core/transport/directory"
import { directoryRoute } from "@clavia/tardigrade-core/transport/router"
import type { ThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { createHost, type Host } from "@clavia/tardigrade-host/host"
import { createBunHost, type BunHost } from "@clavia/tardigrade-bun/host"

test.each(["memory", "sqlite"] as const)("the developer flow allocates scoped threads and receives typed results across instances (%s)", async (backend) => {
  const message = legacyActorMethod({
    input: Schema.Struct({ text: Schema.String }), output: Schema.String,
    event: ({ invocation, input, at }): Event => ({ type: "MessageRequested", id: invocation.id, text: input.text, at }),
    state: (events, invocation) => {
      const done = events.find((event) => event.type === "MessageCompleted" && event.id === invocation.id)
      return done === undefined ? { status: "pending" } : { status: "completed", output: String(done.output) }
    }
  })
  const responder = legacyComponent({
    name: "responder",
    keys: { prefixes: ["message:"], keyOf: (event) => event.type === "MessageCompleted" ? `message:${String(event.id)}` : undefined },
    derive: (events) => ({
      view: undefined,
      transitions: events.filter((event) => event.type === "MessageRequested").map((request) => intent({
        key: `message:${String(request.id)}`, input: request,
        events: (input) => [{ type: "MessageCompleted", id: input.id, output: input.text }]
      }))
    })
  })
  const tardie = defineActor("tardie", { message }, [responder])
  let attempts = 0
  let unnamed: ReadonlyArray<ThreadAddress> | undefined
  const program = Effect.gen(function* () {
    attempts++
    const rickRef = yield* tardie.allocateRootThread({ instance: "rick", name: "main" })
    const rickLabRef = yield* tardie.allocateRootThread({ instance: "rick", name: "lab" })
    const mortyRef = yield* tardie.allocateRootThread({ instance: "morty", name: "main" })
    const mortyLabRef = yield* tardie.allocateRootThread({ instance: "morty", name: "lab" })
    const roots = [rickRef, rickLabRef, mortyRef, mortyLabRef]
    expect(new Set(roots.map((ref) => JSON.stringify(ref.address))).size).toBe(4)
    expect((yield* tardie.allocateRootThread({ instance: "rick", name: "main" })).address).toEqual(rickRef.address)

    const researcherRef = yield* tardie.allocateChildThread({ parent: rickRef, name: "researcher" })
    const labResearcherRef = yield* tardie.allocateChildThread({ parent: rickLabRef, name: "researcher" })
    const mortyResearcherRef = yield* tardie.allocateChildThread({ parent: mortyRef, name: "researcher" })
    const children = [researcherRef, labResearcherRef, mortyResearcherRef]
    expect(new Set(children.map((ref) => JSON.stringify(ref.address))).size).toBe(3)
    expect((yield* tardie.allocateChildThread({ parent: rickRef, name: "researcher" })).address).toEqual(researcherRef.address)
    expect(researcherRef.address.instance).toBe("rick")
    expect(mortyResearcherRef.address.instance).toBe("morty")
    const generatedRoot = yield* tardie.allocateRootThread({ instance: "rick" })
    const generatedChild = yield* tardie.allocateChildThread({ parent: rickRef })
    const secondChild = yield* tardie.allocateChildThread({ parent: rickRef })
    const generated: ReadonlyArray<ThreadAddress> = [generatedRoot.address, generatedChild.address, secondChild.address]
    if (unnamed === undefined) unnamed = generated
    else expect(generated).toEqual(unnamed)
    expect(new Set(generated.map((address) => address.thread)).size).toBe(3)
    for (const address of generated) expect(address.thread).toMatch(/^[a-z]+-[a-z]+-[a-z2-7]{4}$/)
    expect(yield* generatedRoot.message({ text: "generated root" }, { key: "generated-root" })).toBe("generated root")

    const rickResponse = yield* rickLabRef.message({
      text: "Design an experiment to test the portal gun's power source."
    }, { key: "portal-experiment" })
    const mortyResponse = yield* mortyRef.message({
      text: "Help me plan my day around school and homework."
    }, { key: "school-plan" })
    return { rickResponse, mortyResponse }
  })
  const output = Schema.Struct({ rickResponse: Schema.String, mortyResponse: Schema.String })
  const run = legacyActorMethod({
    input: Schema.Struct({}), output,
    event: ({ invocation, at }): Event => ({ type: "ProgramRequested", id: invocation.id, at }),
    state: (events, invocation) => {
      const done = events.find((event) => event.type === "ProgramCompleted" && event.id === invocation.id)
      return done === undefined ? { status: "pending" } : { status: "completed", output: Schema.decodeUnknownSync(output)(done.output) }
    }
  })
  const workflow = legacyComponent({
    name: "workflow",
    keys: { prefixes: ["program:"], keyOf: (event) => event.type === "ProgramCompleted" ? `program:${String(event.id)}` : undefined },
    derive: (events) => ({
      view: undefined,
      transitions: events.filter((event) => event.type === "ProgramRequested").map((request) => effect({
        key: `program:${String(request.id)}`,
        invocation: { method: "run", id: String(request.id), epoch: 0 },
        input: request,
        act: () => program.pipe(
          Effect.map((output) => [{ type: "ProgramCompleted", id: request.id, output }]),
          Effect.orDie
        )
      }))
    })
  })
  const caller = defineActor("tardie", { message, run }, [responder, workflow])
  const hosts = new Map<string, Host | BunHost>()
  const close: Array<() => Promise<void>> = []
  try {
    for (const instance of ["rick", "morty"]) {
      const options = {
        actorName: "tardie", actorInstance: instance,
        threadAllocator: { allocate: (request: ThreadAllocation) => Effect.promise(() => {
          const target = request.kind === "root" ? request.coordinate : request.parent
          return hosts.get(target.instance)!.assignThread(request)
        }) },
        initializeRoot: (target: ThreadAddress, at: number) => hosts.get(target.instance)!.initializeRoot(target, at),
        actorFor: (thread: string) => thread === "caller" ? caller : tardie,
        keyOf: (event: Event) => methodIngressKeyOf(event) ?? actorRuntimeOf(caller).keyOf(event),
        driver: { maxConcurrentThreads: 1 },
        routes: [directoryRoute(
          { name: "other-instance", send: (host: Host | BunHost, envelope) => Effect.promise(() => host.commit(envelope)) },
          mappedDirectory((target: ThreadAddress) =>
            target.actor === "tardie" && target.instance !== instance ? hosts.get(target.instance) : undefined),
          isActorEnvelope,
          (envelope) => envelope.link.target
        )]
      }
      if (backend === "memory") hosts.set(instance, createHost(options))
      else {
        const host = await createBunHost({ ...options, database: ":memory:", workspaceSql: false })
        hosts.set(instance, host)
        close.push(() => host.close())
      }
    }
    const rick = hosts.get("rick")!
    const morty = hosts.get("morty")!
    await rick.commitRoot(rick.self("caller"), prepareInvocation({
      reference: { target: { actor: "tardie", instance: "rick", thread: "caller" }, invocation: { method: "run", id: "start", epoch: 0 } },
      method: run, input: {}, at: Date.now()
    }).event)
    for (let round = 0; round < 8; round++) {
      await rick.drive()
      await morty.drive()
      if ((await rick.read("caller")).some((event) => event.type === "ProgramCompleted")) break
    }
    expect((await rick.read("caller")).find((event) => event.type === "ProgramCompleted")?.output).toEqual({
      rickResponse: "Design an experiment to test the portal gun's power source.",
      mortyResponse: "Help me plan my day around school and homework."
    })
    expect(attempts).toBeGreaterThan(1)
    for (const host of hosts.values()) {
      for (const thread of ["main", "lab"]) {
        expect((await host.read(thread)).filter((event) => event.type === "ThreadCreated")).toHaveLength(1)
      }
    }
    expect((await rick.read("main")).some((event) => event.type === "MessageRequested")).toBe(false)
    expect((await morty.read("lab")).some((event) => event.type === "MessageRequested")).toBe(false)
    await rick.wake("caller")
    await morty.drive()
    expect((await rick.read("lab")).filter((event) => event.type === "MessageRequested")).toHaveLength(1)
    expect((await morty.read("main")).filter((event) => event.type === "MessageRequested")).toHaveLength(1)
    expect((await rick.read("caller")).filter((event) => event.type === "ProgramCompleted")).toHaveLength(1)
  } finally {
    for (const dispose of close) await dispose()
  }
})
