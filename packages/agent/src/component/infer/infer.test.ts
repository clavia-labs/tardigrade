import { renderOf as renderWithoutData } from "../../runtime/render"
import { ModelLock } from "@clavia/tardigrade-model/lock"
import { testModelData } from "../../../fixtures/model"
import { AGENT_VIEW_ALGEBRA } from "../view"
import { modelRequest } from "../../model/request"
import { messages } from "../messages"
import { testMachineOf as machineOf } from "@clavia/tardigrade-agent/fixtures/component"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import { describe, expect, test } from "bun:test"
import { Context, Effect } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { actorRuntimeOf } from "@clavia/tardigrade-core/runtime"
import { actor, component, legacyComponent } from "@clavia/tardigrade-core/actor"
import { defineOutputFallback, infer, type AgentComponent, type AgentView } from "./index"
import { codeMode } from "../code/index"
import { compact, compaction } from "../compact/index"
import { agentMethods } from "../../actor/methods"
import { tool } from "../tool/index"
import { nativeOutput } from "../native-output"
import { selectedModelOf } from "./machine"

const renderOf: typeof renderWithoutData = (components, log, options) => renderWithoutData(components, log, { data: testModelData, ...options })

const TEST_MODEL = { models: { default: { provider: "test", model_id: "test-model" }, allow: "*" } } as const

const assembled = <R>(component: AgentComponent<R>) => actor({
  name: "test-agent",
  methods: agentMethods,
  components: [component]
})

// The component assembly end to end: the render the model sees is the composed view, and a call
// routes through the same derived tool binding.

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

  test("reported and estimated costs remain independent through replay", () => {
    const machine = machineOf(infer([nativeOutput], TEST_MODEL))
    const read = (events: ReadonlyArray<Event>) => replayProjection(machine, events, testModelData).view
    const head = { type: "MessageReceived", id: "m1", text: "go", at: 1 }
    const called = { type: "ModelCalled", turn: "m1", ordinal: 0, pricing: { promptUsdPerToken: 0.001, completionUsdPerToken: 0.002 }, at: 2 }
    const returned = { type: "ModelReturned", turn: "m1", ordinal: 0, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } }, at: 3 }
    expect(read([head])).toMatchObject({ reportedCostUsd: 0, estimatedCostUsd: 0 })
    expect(read([head, called, returned])).toMatchObject({ reportedCostUsd: undefined, estimatedCostUsd: 0.02 })
    expect(read([head, called, { ...returned, reportedCostUsd: 0.03 }])).toMatchObject({ reportedCostUsd: 0.03, estimatedCostUsd: 0.02 })
    expect(read([head, called, { ...returned, reportedCostUsd: 0 }])).toMatchObject({ reportedCostUsd: 0, estimatedCostUsd: 0.02 })
    expect(read([head, called, { ...returned, usage: {} }])).toMatchObject({ reportedCostUsd: undefined, estimatedCostUsd: undefined })
    expect(read([head])).not.toHaveProperty("spendUsd")
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

  test("an assembly must declare one output strategy", () => {
    expect(() => machineOf(infer([echoTable], TEST_MODEL)).initial(testModelData)).toThrow("must declare one output strategy")
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
    expect(() => replayProjection(machineOf(changing), [{ type: "Ready" }])).toThrow("must declare one applicable fallback for every log")
  })

  test("two components declaring one tool name collide at initialization", () => {
    expect(() => machineOf(infer([echoTable, tool([{ spec: { name: "echo", description: "again", inputSchema: {} }, run: () => Effect.succeed({}) }], "", { name: "other-tools" }), nativeOutput], TEST_MODEL)).initial(testModelData)).toThrow(
      'tool "echo" declared more than once'
    )
  })

  test("a duplicate tool derived after construction fails for that log", () => {
    const later = viewComponent(
      "later",
      (log) => ({
        system: [],
        tools: log.some((event) => event.type === "Ready")
          ? [{ spec: { name: "echo", description: "later", inputSchema: {} } }]
          : [],
        context: [],
        output: []
      })
    )
    const agent = assembled(infer([echoTable, later, nativeOutput], TEST_MODEL))

    expect(agent.components).toHaveLength(1)
    expect(actorRuntimeOf(agent).projections).toHaveLength(1)
    expect(actorRuntimeOf(agent).projection).toBeDefined()
    expect(() => renderOf([echoTable, later, nativeOutput], [{ type: "Ready" }])).toThrow('tool "echo" declared more than once')
  })

  test("compaction's context reaches the render, so the guard and the request hold one policy", () => {
    const render = renderOf([codeMode(), compaction({ messageRenderCap: 1234 }), nativeOutput], [])
    expect(render.context).toMatchObject({
      messageRenderCap: 1234
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



})

describe("upward conversation composition", () => {
  const history: ReadonlyArray<Event> = [{ type: "MessageReceived", id: "m", text: "abcdefghijklmnopqrstuvwxyz", at: 1 }]

  test("the composed cap governs the rendered conversation", () => {
    const cap = viewComponent("cap", { ...AGENT_VIEW_ALGEBRA.empty, context: [{ component: "cap", policy: { messageRenderCap: 5 } }] })
    const rendered = renderOf([messages(), cap, nativeOutput], history)
    const request = modelRequest(history, rendered, rendered.context)
    expect(request.messages[0]?.content).toContain("abcde…[truncated at 5 of 26 chars")
  })

  test("compact inherits child policy and allows an explicit wrapper override", () => {
    const inherited = renderOf([compact(messages({ context: { messageRenderCap: 5 } }), {}), nativeOutput], history)
    const overridden = renderOf([compact(messages({ context: { messageRenderCap: 5 } }), { messageRenderCap: 10 }), nativeOutput], history)
    expect(modelRequest(history, inherited, inherited.context).messages[0]?.content).toContain("truncated at 5")
    expect(modelRequest(history, overridden, overridden.context).messages[0]?.content).toContain("truncated at 10")
  })

})

test("infer advances one child snapshot per event and forwards cancellation once", () => {
  let steps = 0
  const cancelled: number[] = []
  const child = component({
    name: "counter",
    initial: () => 0,
    step: (state) => { steps += 1; return state + 1 },
    output: (state) => ({
      view: ({
        ...AGENT_VIEW_ALGEBRA.empty,
        system: [`events:${state}`],
        used: state
      }), transitions: [], interactions: {
        cancel: () => { cancelled.push(state); return [] }
      }
    }),

  })
  const machine = machineOf(infer([child, nativeOutput]))
  let state = machine.initial(testModelData)
  steps = 0
  state = machine.step(state, { type: "Observed" })
  state = machine.step(state, { type: "Observed" })
  expect(steps).toBe(2)
  expect(machine.output(state).view.system).toContain("events:2")
  machine.output(state).interactions?.cancel?.({ request: "stop", invocation: { method: "message", id: "t", epoch: 0 }, cause: "requested" })
  expect(cancelled).toEqual([2])
  expect(steps).toBe(2)
})

test("inference requires host model data before initialization", () => {
  expect(() => machineOf(infer([nativeOutput], TEST_MODEL)).initial(Context.empty())).toThrow("tardigrade/model/ModelLock")
})

test("fallback decoration defers dependency initialization and validates output", () => {
  const fallback = defineOutputFallback(component({
    name: "dependent-fallback",
    dependencies: [ModelLock],
    initial: (_children, [lock]) => lock,
    step: state => state,
    output: lock => ({
      view: { ...AGENT_VIEW_ALGEBRA.empty, system: [lock.resolve(TEST_MODEL.models.default).model.model_id], output: [{
        component: "dependent-fallback", kind: "fallback" as const,
        fallback: { kind: "local" as const, name: "validate-once" as const }
      }] },
      transitions: []
    })
  }))
  const machine = machineOf(fallback)
  expect(() => machine.initial(Context.empty())).toThrow("ModelLock")
  expect(machine.output(machine.initial(testModelData)).view.output).toMatchObject([
    { fallback: { kind: "local", name: "validate-once" } }
  ])
  const invalid = defineOutputFallback(viewComponent("invalid", () => AGENT_VIEW_ALGEBRA.empty))
  expect(() => machineOf(invalid).output(machineOf(invalid).initial(testModelData)))
    .toThrow("must declare one applicable fallback")
})
