import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Ref } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { FetchHttpClient } from "effect/unstable/http"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import { Router } from "@clavia/tardigrade-core/communication/router"
import { parseThreadAddress } from "@clavia/tardigrade-core/communication/endpoint"
import { Self, effect, settleActor } from "@clavia/tardigrade-core/runtime"
import { actor, composeComponents, deriveComponent, legacyComponent } from "@clavia/tardigrade-core/actor"
import {
  CODE_VIEW_ALGEBRA,
  definePackage,
  type CodeComponent,
  type Package
} from "@clavia/tardigrade-code/package/definition"
import { fetchPackage } from "@clavia/tardigrade-code/package/fetch"
import { defineOutputFallback, infer, renderOf, type AgentComponent, type AgentView } from "./composition"
import { CODE_SYSTEM, codeMode, codeSystemFor } from "../component/code"
import { budget } from "../component/budget"
import { compaction } from "../component/compaction"
import { agentMethods } from "../actor/methods"
import { tool } from "../component/tool"
import { nativeOutput } from "../component/native-output"
import { system } from "../component/system"
import { permissions } from "../component/permissions"
import { requestPermissionMethod } from "../actor/permission"
import { receive } from "./turn"
import { Infer, NativeOutputSupport, type InferRequest } from "../inference/contract"
import { selectedModelOf } from "../inference/machine"

const TEST_MODEL = { models: { default: { provider: "test", model_id: "test-model" }, allow: "*" } } as const

const assembled = <R>(component: AgentComponent<R>) => actor({
  name: "test-agent",
  methods: agentMethods,
  components: [component]
})

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
  Layer.succeed(Router, {
    send: () => Effect.void
  }),
  Layer.succeed(Self, parseThreadAddress("test-agent:main:main")),
  Layer.succeed(NativeOutputSupport, { withTools: true })
)

const readLog = Effect.flatMap(EventLog, (log) => log.read)
const run = <A, R>(effect: Effect.Effect<A, never, R>, layers: Layer.Layer<R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layers)) as Effect.Effect<A>)

const echoTable = tool([
  {
    spec: { name: "echo", description: "echoes", inputSchema: { type: "object" } },
    run: (input) => Effect.succeed({ echoed: input })
  }
])

const viewComponent = (
  name: string,
  view: AgentView | ((log: ReadonlyArray<Event>) => AgentView)
): AgentComponent => legacyComponent({
  name,
  derive: (log) => ({ view: typeof view === "function" ? view(log) : view, transitions: [] })
})

describe("infer component", () => {
  test("the built-in agent root exposes an incremental projection", () => {
    const component = infer([budget([codeMode()]), compaction(), nativeOutput], TEST_MODEL)
    expect(component.machine).toBeDefined()
    const definition = assembled(component)
    expect(definition.projections.every((reactor) => "initial" in reactor)).toBe(true)
    expect(definition.projection).toBeDefined()
  })

  test("the actor owns model selection", () => {
    const fallback = { provider: "cloudflare", model_id: "openai/gpt-5.6-luna" } as const
    const message = {
      type: "MessageReceived",
      id: "m1",
      text: "go",
      model: { provider: "vercel", model_id: "anthropic/claude-sonnet-4-6" },
      at: 1
    } as Event
    expect(selectedModelOf(message, fallback)).toEqual({
      provider: "vercel",
      model_id: "anthropic/claude-sonnet-4-6"
    })
    expect(selectedModelOf({ ...message, model: undefined } as Event, fallback)).toEqual(fallback)
  })

  test("a turn without any applicable default durably asks for a model reference", async () => {
    let calls = 0
    const mind = Layer.succeed(Infer, {
      react: () => {
        calls += 1
        return Effect.succeed({ kind: "complete" as const, output: "done" })
      }
    })
    const agent = assembled(infer([nativeOutput], {
      models: {
        allow: [{ provider: "openai", model_ids: ["large", "small"] }]
      }
    }))
    const events = await run(
      Effect.gen(function* () {
        yield* receive(agent, { id: "m1", text: "choose" })
        return yield* readLog
      }),
      Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory)
    )
    expect(events.find((event) => event.type === "TurnFailed")).toMatchObject({
      turn: "m1",
      cause: "model_selection",
      attempts: 0
    })
    expect(calls).toBe(0)
  })

  test("an actor with no model override inherits the host default", async () => {
    const selected = { provider: "openai", model_id: "small" } as const
    const seen: InferRequest[] = []
    const mind = Layer.succeed(Infer, {
      resolve: (model) => ({
        model: model ?? selected,
        models: {
          default: selected,
          allow: [{ provider: "openai", model_ids: ["large", "small"] }]
        }
      }),
      react: (request: InferRequest) => {
        seen.push(request)
        return Effect.succeed({ kind: "complete" as const, output: "done" })
      }
    })
    const agent = assembled(infer([nativeOutput]))
    const events = await run(
      Effect.gen(function* () {
        yield* receive(agent, { id: "m1", text: "inherit" })
        return yield* readLog
      }),
      Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory)
    )
    expect(seen.map((request) => request.model)).toEqual([selected])
    const called = events.find((event) => event.type === "ModelCalled")
    expect(called).toMatchObject({ model: selected })
    expect(called).not.toHaveProperty("models")
  })

  test("a died attempt retries the model recorded by ModelCalled", async () => {
    const recorded = { provider: "openai", model_id: "small" } as const
    const current = { provider: "openai", model_id: "large" } as const
    const seen: InferRequest[] = []
    const mind = Layer.succeed(Infer, {
      resolve: (model) => ({ model: model ?? current, models: { default: current, allow: "*" } }),
      react: (request: InferRequest) => {
        seen.push(request)
        return Effect.succeed({ kind: "complete" as const, output: "done" })
      }
    })
    const agent = assembled(infer([nativeOutput], { models: { default: current, allow: "*" } }))
    const events = await run(
      Effect.gen(function* () {
        yield* settleActor(agent)
        return yield* readLog
      }),
      Layer.mergeAll(
        memoryLog([
          { type: "MessageReceived", id: "m1", text: "retry", at: 1 },
          { type: "ModelCalled", callId: "m1/infer/0", model: recorded, ordinal: 0, turn: "m1", at: 2 }
        ]),
        mind,
        noRouter,
        KeyValueStore.layerMemory
      )
    )
    expect(seen.map((request) => request.model)).toEqual([recorded])
    expect(events.filter((event) => event.type === "ModelCalled").map((event) =>
      (event as { readonly model?: unknown }).model
    )).toEqual([recorded, recorded])
  })

  test("a historical model string durably fails its turn", async () => {
    const seen: InferRequest[] = []
    const mind = Layer.succeed(Infer, {
      react: (request: InferRequest) => {
        seen.push(request)
        return Effect.succeed({ kind: "complete" as const, output: "done" })
      }
    })
    const agent = assembled(infer([nativeOutput], TEST_MODEL))
    const events = await run(
      Effect.gen(function* () {
        yield* settleActor(agent)
        yield* receive(agent, {
          id: "m2",
          text: "continue",
          model: { provider: "openai", model_id: "gpt-5.6" }
        })
        return yield* readLog
      }),
      Layer.mergeAll(memoryLog([{
        type: "MessageReceived",
        id: "m1",
        text: "old",
        model: "gpt-4o",
        at: 1
      }]), mind, noRouter, KeyValueStore.layerMemory)
    )
    expect(events.find((event) => event.type === "TurnFailed")).toMatchObject({
      turn: "m1",
      cause: "message_invalid",
      attempts: 0
    })
    expect(seen.map((request) => request.model)).toEqual([
      { provider: "openai", model_id: "gpt-5.6" }
    ])
    expect(events.at(-1)?.type).toBe("TurnCompleted")
  })

  test("each turn can select a provider without losing its conversation", async () => {
    const seen: InferRequest[] = []
    const mind = Layer.succeed(Infer, {
      react: (request: InferRequest) => {
        seen.push(request)
        return Effect.succeed({ kind: "complete" as const, output: "done" })
      }
    })
    const agent = assembled(infer(
      [
            compaction({
        contextWindowTokens: (model) =>
          model?.provider === "vercel" ? 200_000 : 100_000
      }),
      nativeOutput
    ], {
      models: {
        default: { provider: "vercel", model_id: "anthropic/claude-sonnet-4-6" },
        allow: "*"
      }
    }))
    const events = await run(
      Effect.gen(function* () {
        yield* receive(agent, {
          id: "m1",
          text: "first",
          model: { provider: "vercel", model_id: "anthropic/claude-sonnet-4-6" }
        })
        yield* receive(agent, {
          id: "m2",
          text: "second",
          model: { provider: "openai", model_id: "gpt-5.6" }
        })
        return yield* readLog
      }),
      Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory)
    )
    expect(seen.map((request) => request.model)).toEqual([
      { provider: "vercel", model_id: "anthropic/claude-sonnet-4-6" },
      { provider: "openai", model_id: "gpt-5.6" }
    ])
    expect(seen[0]?.context?.contextWindowTokens).toBe(200_000)
    expect(seen[1]?.context?.contextWindowTokens).toBe(100_000)
    expect(seen[1]?.trajectory.filter((event) => event.type === "MessageReceived").map((event) =>
      (event as { readonly id?: unknown }).id
    )).toEqual(["m1", "m2"])
    expect(events.filter((event) => event.type === "ModelCalled")).toMatchObject([
      { turn: "m1", model: { provider: "vercel", model_id: "anthropic/claude-sonnet-4-6" } },
      { turn: "m2", model: { provider: "openai", model_id: "gpt-5.6" } }
    ])
  })

  test("an assembly must declare one output strategy", () => {
    expect(() => assembled(infer([echoTable], TEST_MODEL))).toThrow("must declare one output strategy")
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
    expect(() => deriveComponent(changing, [{ type: "Ready" }])).toThrow("must declare one applicable fallback for every log")
  })

  test("the render is the composed output, and the request carries it to the model", async () => {
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
    const agent = assembled(infer([budget([echoTable]), compaction(), nativeOutput], TEST_MODEL))
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
    expect(events.at(-1)?.type).toBe("TurnCompleted")
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
    const agent = assembled(infer([echoTable, nativeOutput], TEST_MODEL))
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

  test("a direct package call teaches the execute calling convention", async () => {
    const mind = Layer.succeed(Infer, {
      react: (request: InferRequest) => {
        const returned = request.trajectory.find((event) => event.type === "ToolReturned") as { result?: unknown } | undefined
        return Effect.succeed(
          returned === undefined
            ? { kind: "call" as const, callId: "c10", name: "fetch.get", arguments: { url: "https://example.com" } }
            : { kind: "complete" as const, output: JSON.stringify(returned.result) }
        )
      }
    })
    const agent = assembled(infer([codeMode([fetchPackage()]), nativeOutput], TEST_MODEL))
    const events = await run(
      Effect.gen(function* () {
        yield* receive(agent, { id: "m1", text: "go" })
        return yield* readLog
      }),
      Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory, FetchHttpClient.layer)
    )
    expect(events.find((event) => event.type === "ToolReturned")).toMatchObject({
      result: {
        error: "unknown tool: fetch.get. Package methods run inside execute. Call execute with JavaScript such as `return await fetch.get({...})`."
      }
    })
  })

  test("two components declaring one tool name collide at construction", () => {
    expect(() => assembled(infer([echoTable, tool([{ spec: { name: "echo", description: "again", inputSchema: {} }, run: () => Effect.succeed({}) }]), nativeOutput], TEST_MODEL))).toThrow(
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
    const agent = assembled(infer([echoTable, later, nativeOutput], TEST_MODEL))

    expect(agent.components).toHaveLength(1)
    expect(agent.projections).toHaveLength(1)
    expect(agent.projection).toBeDefined()
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
        yield* receive(assembled(infer([ephemeral, nativeOutput], TEST_MODEL)), { id: "m1", text: "go" })
        return yield* readLog
      }),
      Layer.mergeAll(memoryLog(), mind, noRouter, KeyValueStore.layerMemory)
    )

    expect(events.find((event) => event.type === "ToolReturned")).toMatchObject({ result: "served" })
  })

  test("compaction's context reaches the render, so the guard and the request hold one policy", () => {
    const render = renderOf([codeMode(), compaction({ messageRenderCap: 1234 }), nativeOutput], [])
    expect(render.context).toMatchObject({
      messageRenderCap: 1234,
      contextWindowTokens: 128_000,
      fireRatio: 0.8,
      keepRatio: 0.5,
      fireTokens: 102_400,
      keepTokens: 64_000
    })
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

  test("a legacy system projection observes replay prefixes through the requested log", () => {
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
    expect(seen).toEqual([[], log.slice(0, 1), log])
    expect(render.system).toContain("packages: github, slack")
    // A constant fragment stays what it says, beside the derived one.
    expect(render.system).toContain("echo")
  })

  test("system contributes static or projected instructions as a component", () => {
    const log: ReadonlyArray<Event> = [{ type: "PackageInstalled", name: "github" }]
    const fixed = system("review the repository")
    const projected = system((events) => `recorded events: ${events.length}`)
    const incremental = system({
      initial: () => 0,
      step: (count, event) => count + (event.type === "PackageInstalled" ? 1 : 0),
      output: (count) => `installed packages: ${count}`
    })
    const render = renderOf([
      fixed,
      projected,
      incremental,
      nativeOutput
    ], log)

    expect(render.system).toBe("review the repository\nrecorded events: 1\ninstalled packages: 1")
    expect(fixed.machine).toBeDefined()
    expect(projected.machine).toBeDefined()
    expect(incremental.machine).toBeDefined()
    expect(nativeOutput.machine).toBeDefined()
    expect(echoTable.machine).toBeDefined()
    expect(permissions([echoTable], {
      authority: {
        address: parseThreadAddress("permission:main:root"),
        methods: { requestPermission: requestPermissionMethod }
      },
      request: () => undefined
    }).machine).toBeDefined()
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
    // package prose followed by each documented input and output shape (component/code.ts,
    // codeSystemFor).
    const notes: Package = definePackage({
      name: "notes",
      description: "the team's notes",
      docs: {
        put: {
          description: "Save one note.",
          input: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"]
          },
          output: {
            type: "object",
            properties: { ok: { type: "boolean" }, error: { type: "string" } },
            required: ["ok"]
          }
        }
      },
      methods: { put: () => Effect.succeed(null) }
    })
    const { system } = renderOf([codeMode([notes]), nativeOutput], [])
    expect(system).toContain("notes: the team's notes")
    expect(system).toContain("notes.put({text: string}) -> {ok: boolean, error?: string}: Save one note.")
    expect(system).not.toContain("none")
    // An explicit fragment still wins over the component output.
    expect(renderOf([codeMode([notes], { system: "my own scope" }), nativeOutput], []).system).toBe("my own scope")
  })

  test("package docs show fetch input and output shapes", () => {
    const system = codeSystemFor([fetchPackage()])
    expect(system).toContain("The execute tool runs an async JavaScript body")
    expect(system).toContain("const value = await package.method(input); return value")
    expect(system).toContain("fetch.get({url: string, headers?: object})")
    expect(system).toContain("-> {status?: number, headers?: object, body?: string, truncated?: boolean, error?: string}")
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
    const upkeep: CodeComponent = legacyComponent({
      name: "upkeep",
      keys: {
        prefixes: ["up:"],
        keyOf: (event) => event.type === "CodeUpkeepCompleted" ? `up:${String(event.id)}` : undefined
      },
      derive: () => ({
        view: { packages: [] },
        transitions: [
          effect({
            key: "up:daily",
            input: undefined,
            act: () => Effect.succeed([{ type: "CodeUpkeepCompleted", id: "daily" }])
          })
        ]
      })
    })
    const nested = composeComponents("knowledge", CODE_VIEW_ALGEBRA, [notes, upkeep, search])
    const component = codeMode([nested])
    const derived = deriveComponent(component, [])

    expect(derived.view.system[0]).toContain("notes: the team's notes\nsearch: the team's index")
    expect(derived.transitions.map((transition) => transition.key)).toEqual(["up:daily"])
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
    // (component/code.ts, codeMode).
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
