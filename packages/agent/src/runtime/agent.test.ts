import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Ref } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import type { Event } from "@clavia/tardigrade-core/event"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/event-log"
import { Transport } from "@clavia/tardigrade-core/transport"
import { parseActorAddress } from "@clavia/tardigrade-core/communication/address"
import { Facets } from "@clavia/tardigrade-core/facets"
import { Self, transition } from "@clavia/tardigrade-core/actor"
import { actor, composeComponents } from "@clavia/tardigrade-core/component"
import {
  CODE_VIEW_ALGEBRA,
  definePackage,
  type CodeComponent,
  type Package
} from "@clavia/tardigrade-code/packages"
import { defineOutputFallback, infer, renderOf, type AgentComponent, type AgentView } from "./agent"
import { CODE_SYSTEM, codeMode } from "../components/code"
import { budget } from "../components/budget"
import { compaction, compactionFor } from "../components/compaction"
import { reply } from "../components/reply"
import { toolList } from "../components/tool-list"
import { nativeOutput } from "../components/native-output"
import { system } from "../components/system"
import { receive } from "../turn"
import { Infer, NativeOutputSupport, type InferRequest } from "./infer"

// The component assembly end to end: the render the model sees is the composed view, and a call
// routes through the same derived tool binding.

// Ticker is a service no assembled agent provides, so a component that requires it is
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
  Layer.succeed(Transport, {
    deliver: () => Effect.void,
    call: () => Effect.succeed({ error: "no transport bound" }),
    resume: () => Effect.succeed({ error: "no transport bound" })
  }),
  Layer.succeed(Self, parseActorAddress("test-agent")),
  Layer.succeed(NativeOutputSupport, { withTools: true })
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

const viewComponent = (
  name: string,
  view: AgentView | ((log: ReadonlyArray<Event>) => AgentView)
): AgentComponent => ({
  name,
  derive: (log) => ({ view: typeof view === "function" ? view(log) : view, transitions: [] })
})

describe("infer component", () => {
  test("an assembly must declare one output strategy", () => {
    expect(() => actor(infer([echoTable]))).toThrow("must declare one output strategy")
  })

  test("a marked output fallback must be present for every log", () => {
    const changing = defineOutputFallback(viewComponent("changing-output", (log) => ({
      system: [],
      tools: [],
      context: [],
      output: log.length === 0
        ? [{ component: "changing-output", kind: "fallback", fallback: { kind: "local", name: "validate-once" } }]
        : []
    })))
    expect(() => changing.derive([{ type: "Ready" }])).toThrow("must declare one applicable fallback for every log")
  })

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
    const agent = actor(infer([echoTable, reply, budget, compaction, nativeOutput]))
    const events = await run(
      Effect.gen(function* () {
        yield* receive(agent, { id: "m1", text: "go" })
        return yield* readLog
      }),
      Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory)
    )
    // The model was shown exactly what the components derived.
    expect(seen[0]!.tools.map((t) => t.name)).toEqual(["echo"])
    expect(seen[0]!.system).toContain("echo")
    // The call routed through the table component's tool binding and settled.
    expect(events.find((e) => e.type === "ToolReturned")).toMatchObject({ callId: "c1", result: { echoed: { hi: 1 } } })
    expect(events.at(-2)?.type).toBe("TurnCompleted")
  })

  test("a call outside the derived tools answers unknown-tool naming the composed tools", async () => {
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
    const agent = actor(infer([echoTable, reply, nativeOutput]))
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

  test("two components declaring one tool name collide at construction", () => {
    expect(() => actor(infer([echoTable, toolList([{ spec: { name: "echo", description: "again", inputSchema: {} }, run: () => Effect.succeed({}) }]), nativeOutput]))).toThrow(
      'tool "echo" declared more than once'
    )
  })

  test("a duplicate tool derived after construction fails for that log", () => {
    const later = viewComponent(
      "later",
      (log) => ({
        system: [],
        tools: log.some((event) => event.type === "Ready")
          ? [{ spec: { name: "echo", description: "later", inputSchema: {} }, serve: (_call, _log, answer) => [answer({})] }]
          : [],
        context: [],
        output: []
      })
    )
    const agent = actor(infer([echoTable, later, nativeOutput]))

    expect(agent.reactors).toHaveLength(1)
    expect(() => renderOf([echoTable, later, nativeOutput], [{ type: "Ready" }])).toThrow('tool "echo" declared more than once')
  })

  test("a tool remains routable from the view that offered its call", async () => {
    const ephemeral = viewComponent(
      "ephemeral",
      (log) => ({
        system: [],
        tools: log.some((event) => event.type === "ToolCalled")
          ? []
          : [{ spec: { name: "once", description: "one call", inputSchema: {} }, serve: (_call, _log, answer) => [answer("served")] }],
        context: [],
        output: []
      })
    )
    const mind = Layer.succeed(Infer, {
      react: (request: InferRequest) => Effect.succeed(
        request.trajectory.some((event) => event.type === "ToolReturned")
          ? { kind: "complete" as const, output: "done" }
          : { kind: "call" as const, callId: "once-1", name: "once", arguments: {} }
      )
    })
    const events = await run(
      Effect.gen(function* () {
        yield* receive(actor(infer([ephemeral, nativeOutput])), { id: "m1", text: "go" })
        return yield* readLog
      }),
      Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory)
    )

    expect(events.find((event) => event.type === "ToolReturned")).toMatchObject({ result: "served" })
  })

  test("compactionFor's context reaches the render, so the guard and the request hold one policy", () => {
    const render = renderOf([codeMode(), compactionFor({ messageRenderCap: 1234 }), nativeOutput], [])
    expect(render.context).toEqual({ messageRenderCap: 1234 })
  })

  test("different values for one context field fail with both component names", () => {
    const left = viewComponent("left", {
      system: [], tools: [], context: [{ component: "left", policy: { messageRenderCap: 10 } }], output: []
    })
    const right = viewComponent("right", {
      system: [], tools: [], context: [{ component: "right", policy: { messageRenderCap: 20 } }], output: []
    })

    expect(() => renderOf([left, right, nativeOutput], [])).toThrow(
      'context field "messageRenderCap" declared by components left and right'
    )
  })

  test("renderOf composes system fragments and tools in mount order", () => {
    const render = renderOf([codeMode(), echoTable, nativeOutput], [])
    expect(render.tools.map((t) => t.name)).toEqual(["execute", "echo"])
    expect(render.system.indexOf("execute")).toBeLessThan(render.system.indexOf("echo"))
  })

  test("a system fragment is a projection: it reads the log renderOf was handed", () => {
    const seen: ReadonlyArray<Event>[] = []
    const log: ReadonlyArray<Event> = [{ type: "PackageInstalled", name: "github" }, { type: "PackageInstalled", name: "slack" }]
    const catalog = viewComponent(
      "catalog",
      (events: ReadonlyArray<Event>) => {
        seen.push(events)
        return {
          system: [`packages: ${events.map((e) => String((e as { name?: unknown }).name)).join(", ")}`],
          tools: [],
          context: [],
          output: []
        }
      }
    )
    const render = renderOf([catalog, echoTable, nativeOutput], log)
    expect(seen).toEqual([log])
    expect(render.system).toContain("packages: github, slack")
    // A constant fragment stays what it says, beside the derived one.
    expect(render.system).toContain("echo")
  })

  test("system contributes static or projected instructions as a component", () => {
    const log: ReadonlyArray<Event> = [{ type: "PackageInstalled", name: "github" }]
    const render = renderOf([
      system("review the repository"),
      system((events) => `recorded events: ${events.length}`),
      nativeOutput
    ], log)

    expect(render.system).toBe("review the repository\nrecorded events: 1")
  })

  test("renderOf over one log is deterministic", () => {
    const log: ReadonlyArray<Event> = [{ type: "PackageInstalled", name: "github" }]
    const component = viewComponent(
      "catalog",
      (events: ReadonlyArray<Event>) => ({ system: [`count: ${events.length}`], tools: [], context: [], output: [] })
    )
    expect(renderOf([codeMode(), component, nativeOutput], log)).toEqual(renderOf([codeMode(), component, nativeOutput], log))
  })

  test("codeMode takes a system fragment, and the empty scope renders the exported default", () => {
    const overridden = renderOf([codeMode([], { system: (events) => `the packages in scope are:\n${events.length}` }), nativeOutput], [{ type: "PackageInstalled" }])
    expect(overridden.system).toBe("the packages in scope are:\n1")
    expect(renderOf([codeMode(), nativeOutput], []).system).toBe(CODE_SYSTEM)
  })

  test("a mounted package names itself in the system fragment", () => {
    // The model is told what the code can name, from the same values the code reactor mounts:
    // one line per package, `name: description` (components/code.ts, codeSystemFor).
    const notes: Package = definePackage({
      name: "notes",
      description: "the team's notes",
      methods: { put: () => Effect.succeed(null) }
    })
    const { system } = renderOf([codeMode([notes]), nativeOutput], [])
    expect(system).toContain("notes: the team's notes")
    expect(system).not.toContain("none")
    // An explicit fragment still wins over the derivation.
    expect(renderOf([codeMode([notes], { system: "my own scope" }), nativeOutput], []).system).toBe("my own scope")
  })

  test("codeMode composes nested code components and preserves their work", () => {
    const notes = definePackage({
      name: "notes",
      description: "the team's notes",
      methods: { read: () => Effect.succeed(null) }
    })
    const search = definePackage({
      name: "search",
      description: "the team's index",
      methods: { find: () => Effect.succeed(null) }
    })
    const upkeep: CodeComponent = {
      name: "upkeep",
      keys: {
        prefixes: ["up:"],
        keyOf: (event) => event.type === "CodeUpkeepCompleted" ? `up:${String(event.id)}` : undefined
      },
      derive: () => ({
        view: { packages: [] },
        transitions: [
          transition({
            key: "up:daily",
            input: undefined,
            act: () => Effect.succeed([{ type: "CodeUpkeepCompleted", id: "daily" }])
          })
        ]
      })
    }
    const nested = composeComponents("knowledge", CODE_VIEW_ALGEBRA, [notes, upkeep, search])
    const component = codeMode([nested])
    const derived = component.derive([])

    expect(derived.view.system[0]).toContain("notes: the team's notes\nsearch: the team's index")
    expect(derived.transitions.map((candidate) => candidate.key)).toEqual(["up:daily"])
    expect(component.keys?.keyOf({ type: "CodeUpkeepCompleted", id: "daily" })).toBe("up:daily")
  })

  test("codeMode rejects duplicate package names inside nested code components", () => {
    const left = definePackage({ name: "notes", description: "left", methods: {} })
    const right = definePackage({ name: "notes", description: "right", methods: {} })
    const nested = composeComponents("duplicate", CODE_VIEW_ALGEBRA, [left, right])

    expect(() => codeMode([nested])).toThrow('package "notes" declared twice')
  })

  test("a mounted package's requirements ride the component's type", () => {
    // Compile-time only: the const type parameter infers the component tuple, so R is the spill
    // store plus exactly what the listed packages require. A widened
    // `ReadonlyArray<Package<Ticker>>` would fail the empty-scope assertions below
    // (components/code.ts, codeMode).
    const ticker: Package<Ticker> = definePackage({
      name: "ticker",
      description: "the clock",
      methods: {
        now: () =>
          Effect.gen(function* () {
            return { tick: yield* Ticker }
          })
      }
    })
    const scoped: AgentComponent<KeyValueStore.KeyValueStore | Ticker> = codeMode([ticker])
    // The union is exactly that: too wide (P falling back to Package<unknown>) fails the line
    // above, and too narrow (P collapsing to the empty tuple) fails the line below.
    // @ts-expect-error a component that requires Ticker cannot pass as one that does not
    const narrowed: AgentComponent<KeyValueStore.KeyValueStore> = codeMode([ticker])
    const empty: AgentComponent<KeyValueStore.KeyValueStore> = codeMode([])
    const bare: AgentComponent<KeyValueStore.KeyValueStore> = codeMode()
    expect([scoped.name, narrowed.name, empty.name, bare.name]).toEqual(["code", "code", "code", "code"])
  })
})
