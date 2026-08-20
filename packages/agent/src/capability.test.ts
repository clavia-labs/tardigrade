import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Ref } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import type { Event } from "@clavia/tardigrade-core/event"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/event-log"
import { Router } from "@clavia/tardigrade-core/router"
import { Facets } from "@clavia/tardigrade-core/facets"
import { Self } from "@clavia/tardigrade-core/actor"
import type { Package } from "@clavia/tardigrade-code/packages"
import { agentOf, budget, CODE_SYSTEM, codeMode, codeModeFor, compaction, compactionFor, renderOf, reply, toolList, type Capability } from "./capability"
import { receive, type AgentR } from "./turn"
import { Infer, type InferRequest } from "./infer"

// The capability assembly end to end: the render the model sees is the composed derivation of
// the mounted capabilities, and a call routes to the capability that declared its tool.

// Ticker is a service no assembled agent provides, so a capability that requires it is
// distinguishable at compile time from one that does not.
class Ticker extends Context.Service<Ticker, string>()("agent/test/Ticker") {}

const memoryLog = (initial: ReadonlyArray<Event> = []) =>
  Layer.effect(
    EventLog,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ReadonlyArray<Event>>(initial)
      return withWatermark({
        append: (events: ReadonlyArray<Event>) => Ref.update(ref, (log) => [...log, ...events]),
        read: Ref.get(ref)
      })
    })
  )

const noRouter = Layer.mergeAll(
  Layer.succeed(Facets, { read: () => Effect.succeed([]) }),
  Layer.succeed(Router, {
    deliver: () => Effect.void,
    call: () => Effect.succeed({ error: "no router bound" }),
    resume: () => Effect.succeed({ error: "no router bound" })
  }),
  Layer.succeed(Self, "test-agent")
)

const readLog = Effect.flatMap(EventLog, (log) => log.read)
const run = <A, R>(effect: Effect.Effect<A, never, R>, layers: Layer.Layer<R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layers)) as Effect.Effect<A>)

const echoTable = toolList([
  {
    spec: { name: "echo", description: "echoes", inputSchema: { type: "object" } },
    run: (input) => Effect.succeed({ echoed: input })
  }
])

describe("agentOf", () => {
  test("the render is the composed derivation, and the request carries it to the model", async () => {
    const seen: InferRequest[] = []
    const mind = Layer.succeed(Infer, {
      react: (request: InferRequest) => {
        seen.push(request)
        const returned = request.trajectory.some((e) => e.type === "ToolReturned")
        return Effect.succeed(
          returned
            ? { kind: "complete" as const, output: "done" }
            : { kind: "call" as const, callId: "c1", name: "echo", arguments: { hi: 1 } }
        )
      }
    })
    const agent = agentOf([echoTable, reply, budget, compaction])
    const events = await run(
      Effect.gen(function* () {
        yield* receive(agent, { id: "m1", text: "go" })
        return yield* readLog
      }),
      Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory)
    )
    // The model was shown exactly what the capabilities derived.
    expect(seen[0]!.tools.map((t) => t.name)).toEqual(["echo"])
    expect(seen[0]!.system).toContain("echo")
    // The call routed to the table capability and settled.
    expect(events.find((e) => e.type === "ToolReturned")).toMatchObject({ callId: "c1", result: { echoed: { hi: 1 } } })
    expect(events.at(-2)?.type).toBe("TurnCompleted")
  })

  test("a call no capability recognizes answers unknown-tool naming the composed tools", async () => {
    const mind = Layer.succeed(Infer, {
      react: (request: InferRequest) => {
        const returned = request.trajectory.find((e) => e.type === "ToolReturned") as { result?: unknown } | undefined
        return Effect.succeed(
          returned === undefined
            ? { kind: "call" as const, callId: "c9", name: "ghost", arguments: {} }
            : { kind: "complete" as const, output: JSON.stringify(returned.result) }
        )
      }
    })
    const agent = agentOf([echoTable, reply])
    const events = await run(
      Effect.gen(function* () {
        yield* receive(agent, { id: "m1", text: "go" })
        return yield* readLog
      }),
      Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory)
    )
    expect(events.find((e) => e.type === "ToolReturned")).toMatchObject({
      result: { error: "unknown tool: ghost. Call one of: echo." }
    })
  })

  test("two capabilities declaring one tool name collide at construction", () => {
    expect(() => agentOf([echoTable, toolList([{ spec: { name: "echo", description: "again", inputSchema: {} }, run: () => Effect.succeed({}) }])])).toThrow(
      'tool "echo" declared by capabilities tools and tools'
    )
  })

  test("compactionFor's context reaches the render, so the guard and the request hold one policy", () => {
    const render = renderOf<AgentR>([codeMode, compactionFor({ messageRenderCap: 1234 })], [])
    expect(render.context).toEqual({ messageRenderCap: 1234 })
  })

  test("renderOf composes system fragments and tools in mount order", () => {
    const render = renderOf([codeMode, echoTable], [])
    expect(render.tools.map((t) => t.name)).toEqual(["execute", "echo"])
    expect(render.system.indexOf("execute")).toBeLessThan(render.system.indexOf("echo"))
  })

  test("a system fragment is a projection: it reads the log renderOf was handed", () => {
    const seen: ReadonlyArray<Event>[] = []
    const log: ReadonlyArray<Event> = [{ type: "PackageInstalled", name: "github" }, { type: "PackageInstalled", name: "slack" }]
    const catalog = {
      name: "catalog",
      system: (events: ReadonlyArray<Event>) => {
        seen.push(events)
        return `packages: ${events.map((e) => String((e as { name?: unknown }).name)).join(", ")}`
      }
    }
    const render = renderOf([catalog, echoTable], log)
    expect(seen).toEqual([log])
    expect(render.system).toContain("packages: github, slack")
    // A constant fragment stays what it says, beside the derived one.
    expect(render.system).toContain("echo")
  })

  test("renderOf over one log is deterministic", () => {
    const log: ReadonlyArray<Event> = [{ type: "PackageInstalled", name: "github" }]
    const capability = { name: "catalog", system: (events: ReadonlyArray<Event>) => `count: ${events.length}` }
    expect(renderOf([codeMode, capability], log)).toEqual(renderOf([codeMode, capability], log))
  })

  test("codeModeFor takes a system fragment, and the bare capability renders the exported default", () => {
    const overridden = renderOf([codeModeFor({ system: (events) => `the packages in scope are:\n${events.length}` })], [{ type: "PackageInstalled" }])
    expect(overridden.system).toBe("the packages in scope are:\n1")
    expect(renderOf([codeMode], []).system).toBe(CODE_SYSTEM)
  })

  test("a mounted package names itself in the system fragment", () => {
    // The model is told what the code can name, from the same values the code reactor mounts:
    // one line per package, `name: description` (capability.ts, codeSystemFor).
    const notes: Package = {
      name: "notes",
      description: "the team's notes",
      methods: { put: () => Effect.succeed(null) }
    }
    const { system } = renderOf([codeModeFor({ packages: [notes] })], [])
    expect(system).toContain("notes: the team's notes")
    expect(system).not.toContain("none")
    // An explicit fragment still wins over the derivation.
    expect(renderOf([codeModeFor({ system: "my own scope", packages: [notes] })], []).system).toBe("my own scope")
  })

  test("a mounted package's requirements ride the capability's type", () => {
    // Compile-time only: `packages` arrives as an option property, and the const type parameter
    // still infers the tuple, so R is the spill store plus exactly what the listed packages
    // require. A widened `ReadonlyArray<Package<Ticker>>` would fail the empty-scope assertions
    // below (capability.ts, codeModeFor).
    const ticker: Package<Ticker> = {
      name: "ticker",
      description: "the clock",
      methods: {
        now: () =>
          Effect.gen(function* () {
            return { tick: yield* Ticker }
          })
      }
    }
    const scoped: Capability<KeyValueStore.KeyValueStore | Ticker> = codeModeFor({ packages: [ticker] })
    // The union is exactly that: too wide (P falling back to Package<unknown>) fails the line
    // above, and too narrow (P collapsing to the empty tuple) fails the line below.
    // @ts-expect-error a capability that requires Ticker cannot pass as one that does not
    const narrowed: Capability<KeyValueStore.KeyValueStore> = codeModeFor({ packages: [ticker] })
    const empty: Capability<KeyValueStore.KeyValueStore> = codeModeFor({})
    const bare: Capability<KeyValueStore.KeyValueStore> = codeModeFor()
    expect([scoped.name, narrowed.name, empty.name, bare.name]).toEqual(["code", "code", "code", "code"])
  })
})
