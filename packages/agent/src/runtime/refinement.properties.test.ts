import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import type { Event } from "@clavia/tardigrade-core/event"
import {
  cancelComponent,
  componentRefinementTrace,
  composeComponents,
  deriveComponent,
  type CompleteComponentProjection,
  type Component,
  type ComponentOutput,
  type InvocationCancellation
} from "@clavia/tardigrade-core/component"
import type { Projection } from "@clavia/tardigrade-core/projection"
import type { Transition } from "@clavia/tardigrade-core/transition"
import { budget } from "../component/budget"
import { codeMode } from "../component/code"
import {
  compaction,
  compactionReactor,
  contextPolicyOf,
  type CompactionPolicy
} from "../component/compaction"
import { nativeOutput } from "../component/native-output"
import { system } from "../component/system"
import { inferenceFromHistory, inferenceMachine } from "../inference/machine"
import {
  AGENT_VIEW_ALGEBRA,
  infer,
  renderOf,
  type AgentComponent,
  type AgentTool,
  type AgentView,
  type InferOptions
} from "./composition"
import {
  incrementalToolsComponentFrom,
  toolsComponentFrom,
  type Answer,
  type PendingCall
} from "./tools"

const MODEL = { provider: "test", model_id: "refinement" } as const
const INFER_OPTIONS = { models: { default: MODEL, allow: "*" } } as const

const normalized = (value: unknown): unknown => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  if (typeof value === "undefined") return "[undefined]"
  if (typeof value === "function") return "[function]"
  if (Array.isArray(value)) return value.map(normalized)
  if (value instanceof Map) return [...value.entries()].map(([key, entry]) => [normalized(key), normalized(entry)])
  if (value instanceof Set) return [...value].map(normalized)
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalized(entry)])
    )
  }
  return String(value)
}

const observableTransition = (transition: Transition<never, unknown>): unknown => {
  const input = transition.input as unknown
  const observedInput = input !== null && typeof input === "object" &&
      typeof (input as { readonly trajectory?: unknown }).trajectory === "function"
    ? { ...input, trajectory: (input as { readonly trajectory: () => unknown }).trajectory() }
    : input
  return normalized({
    kind: transition.kind,
    key: transition.key,
    input: observedInput,
    invocation: transition.invocation,
    concurrent: "concurrent" in transition ? transition.concurrent : undefined
  })
}

const observableView = (view: AgentView): unknown => normalized({
  system: view.system,
  tools: view.tools.map((tool) => tool.spec),
  context: view.context,
  output: view.output
})

const observableComponentOutput = (output: ComponentOutput<AgentView, unknown>): unknown => ({
  view: observableView(output.view),
  transitions: output.transitions.map(observableTransition)
})

const observableTransitions = (transitions: ReadonlyArray<Transition<never, unknown>>): unknown =>
  transitions.map(observableTransition)

const assertAgentRefinement = (
  complete: CompleteComponentProjection<AgentView, unknown>,
  incremental: Component<AgentView, unknown>,
  log: ReadonlyArray<Event>
): void => {
  const cancellationsAt = (prefix: ReadonlyArray<Event>): ReadonlyArray<InvocationCancellation> =>
    prefix.filter((event) => event.type === "MessageReceived").map((event, index) => ({
      request: `cancel-${prefix.length}-${index}`,
      invocation: { method: "message", id: String((event as { readonly id?: unknown }).id), epoch: 0 },
      cause: "requested"
    }))
  for (const step of componentRefinementTrace(complete, incremental, log, cancellationsAt)) {
    const actual = observableComponentOutput(step.incremental as ComponentOutput<AgentView, unknown>)
    const expected = observableComponentOutput(step.replay as ComponentOutput<AgentView, unknown>)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`component output refinement failed at prefix ${step.prefix.length}:\nexpected ${JSON.stringify(expected)}\nreceived ${JSON.stringify(actual)}`)
    }
    for (const cancellation of step.cancellations) {
      const actualCancellation = observableTransitions(cancellation.incremental as ReadonlyArray<Transition<never, unknown>>)
      const expectedCancellation = observableTransitions(cancellation.replay as ReadonlyArray<Transition<never, unknown>>)
      if (JSON.stringify(actualCancellation) !== JSON.stringify(expectedCancellation)) {
        throw new Error(`cancellation refinement failed at prefix ${step.prefix.length} for ${cancellation.cancellation.request}`)
      }
    }
  }
}

const offerLogFor = (log: ReadonlyArray<Event>, call: PendingCall): ReadonlyArray<Event> => {
  const called = log.findIndex(
    (event) => event.type === "ToolCalled" && String((event as { readonly callId?: unknown }).callId) === call.callId
  )
  if (called === -1) return log
  for (let index = called - 1; index >= 0; index--) {
    const event = log[index]!
    if (event.type !== "ModelCalled") continue
    const turn = (event as { readonly turn?: unknown }).turn
    if (call.turn === undefined || turn === undefined || String(turn) === call.turn) return log.slice(0, index)
  }
  return log.slice(0, called)
}

const completeAgent = (
  components: ReadonlyArray<AgentComponent<never> | AgentComponent<unknown>>,
  options: InferOptions
): CompleteComponentProjection<AgentView, unknown> => {
  const combined = composeComponents("refinement.children", AGENT_VIEW_ALGEBRA, components) as AgentComponent<unknown>
  const viewOf = (log: ReadonlyArray<Event>): AgentView => deriveComponent(combined, log).view
  const toolsOf = (log: ReadonlyArray<Event>): ReadonlyArray<AgentTool<unknown>> => viewOf(log).tools
  const offeredTools = (log: ReadonlyArray<Event>, call: PendingCall): ReadonlyArray<AgentTool<unknown>> =>
    toolsOf(offerLogFor(log, call))
  const serve = (call: PendingCall, log: ReadonlyArray<Event>, answer: Answer) =>
    offeredTools(log, call).find((tool) => tool.spec.name === call.name)?.serve(call, log, answer)
  const tools = toolsComponentFrom(
    AGENT_VIEW_ALGEBRA.empty,
    serve,
    (log, call) => offeredTools(log, call).map((tool) => tool.spec)
  ) as AgentComponent<unknown>
  const inference = inferenceFromHistory(
    { ...options, models: options.models ?? {} },
    (log) => renderOf(components, log)
  )
  return {
    derive: (log) => {
      const children = deriveComponent(combined, log)
      const inferred = inference(log)
      const resolvingModel = inferred.some((transition) => transition.key.startsWith("mr:"))
      return {
        view: children.view,
        transitions: resolvingModel
          ? inferred
          : [...inferred, ...deriveComponent(tools, log).transitions, ...children.transitions]
      }
    },
    cancel: (log, cancellation) => [
      ...cancelComponent(combined, log, cancellation),
      ...cancelComponent(tools, log, cancellation)
    ]
  }
}

type TurnKind = "complete" | "tool" | "failed" | "cancelled" | "compacted"

const eventsFor = (kinds: ReadonlyArray<TurnKind>): ReadonlyArray<Event> => kinds.flatMap((kind, index) => {
  const turn = `m${index}`
  const at = index * 20
  const head = { type: "MessageReceived", id: turn, text: `request ${index}`, model: MODEL, at } as Event
  const called = { type: "ModelCalled", callId: `${turn}/infer/0`, turn, model: MODEL, at: at + 1 } as Event
  if (kind === "complete") {
    return [head, called, { type: "TurnCompleted", turn, output: `answer ${index}`, at: at + 2 } as Event]
  }
  if (kind === "failed") {
    return [head, called, { type: "TurnFailed", turn, cause: "model", error: "provider failed", at: at + 2 } as Event]
  }
  if (kind === "cancelled") {
    return [head, called, { type: "TurnCancelled", turn, cause: "requested", request: `x${index}`, at: at + 2 } as Event]
  }
  if (kind === "compacted") {
    return [
      head,
      called,
      { type: "CompactionFired", at: at + 2 } as Event,
      { type: "CompactionCompleted", keepFrom: `m:${turn}`, summary: `summary ${index}`, at: at + 3 } as Event,
      { type: "TurnCompleted", turn, output: `answer ${index}`, at: at + 4 } as Event
    ]
  }
  const callId = `c${index}`
  return [
    head,
    called,
    { type: "ToolCalled", callId, name: "execute", arguments: { code: "return 1" }, turn, at: at + 2 } as Event,
    { type: "CodeDispatched", execId: callId, code: "return 1", turn, at: at + 3 } as Event,
    { type: "CodeSettled", execId: callId, result: 1, turn, at: at + 4 } as Event,
    { type: "ToolReturned", callId, result: { result: 1 }, turn, at: at + 5 } as Event,
    { type: "ModelCalled", callId: `${turn}/infer/1`, turn, model: MODEL, at: at + 6 } as Event,
    { type: "TurnCompleted", turn, output: `answer ${index}`, at: at + 7 } as Event
  ]
})

const historyArbitrary = fc.array(
  fc.constantFrom<TurnKind>("complete", "tool", "failed", "cancelled", "compacted"),
  { maxLength: 5 }
).map(eventsFor)

describe("agent projection refinement", () => {
  test("inference agrees with its complete-history output", () => {
    fc.assert(fc.property(historyArbitrary, (log) => {
      const render = (events: ReadonlyArray<Event>) => ({ system: `events:${events.length}`, tools: [] })
      const renderProjection: Projection<number, ReturnType<typeof render>> = {
        initial: () => 0,
        step: (count) => count + 1,
        output: (count) => render(Array.from({ length: count }, () => ({ type: "Observed" } as Event)))
      }
      const complete = inferenceFromHistory(INFER_OPTIONS, render)
      const incremental = inferenceMachine(INFER_OPTIONS, renderProjection)
      let state = incremental.initial()
      for (let length = 0; length <= log.length; length++) {
        expect(observableTransitions(incremental.output(state) as ReadonlyArray<Transition<never, unknown>>))
          .toEqual(observableTransitions(complete(log.slice(0, length)) as ReadonlyArray<Transition<never, unknown>>))
        const event = log[length]
        if (event !== undefined) state = incremental.step(state, event)
      }
    }), { numRuns: 100 })
  })

  test("tool routing and cancellation refine the complete-history component", () => {
    fc.assert(fc.property(historyArbitrary, (log) => {
      const echo: AgentTool = {
        spec: { name: "execute", description: "echo", inputSchema: {} },
        serve: (call, _events, answer) => [answer({ callId: call.callId })]
      }
      const child = {
        initial: () => undefined,
        step: (state: unknown) => state,
        output: () => ({
          view: { ...AGENT_VIEW_ALGEBRA.empty, tools: [echo] },
          transitions: []
        })
      }
      const completeComponent = toolsComponentFrom(AGENT_VIEW_ALGEBRA.empty, echo.serve, () => [echo.spec])
      const incremental = incrementalToolsComponentFrom(AGENT_VIEW_ALGEBRA.empty, child, (view) => view.tools)
      assertAgentRefinement({
        derive: (prefix) => deriveComponent(completeComponent, prefix),
        cancel: (prefix, cancellation) => cancelComponent(completeComponent, prefix, cancellation)
      }, incremental as Component<AgentView, unknown>, log)
    }), { numRuns: 100 })
  })

  test("compaction refines its complete-history reactor", () => {
    const policy: Partial<CompactionPolicy> = {
      model: MODEL,
      contextWindowTokens: 80,
      fireRatio: 0.5,
      keepRatio: 0.25,
      messageRenderCap: 80,
      resultRenderCap: 80
    }
    const result = fc.check(fc.property(historyArbitrary, (log) => {
      const incremental = compaction(policy) as Component<AgentView, unknown>
      const complete: CompleteComponentProjection<AgentView, unknown> = {
        derive: (prefix) => {
          return {
            view: {
              ...AGENT_VIEW_ALGEBRA.empty,
              context: [{ component: "compaction", policy: contextPolicyOf(policy, MODEL) }]
            },
            transitions: compactionReactor(policy)(prefix)
          }
        }
      }
      assertAgentRefinement(complete, incremental, log)
    }), { numRuns: 100 })
    if (result.failed) throw result.errorInstance
  })

  test("the composed agent refines the complete-history agent", () => {
    fc.assert(fc.property(historyArbitrary, (log) => {
      const components = [
        system("You are the refinement agent."),
        budget([codeMode()]),
        compaction(),
        nativeOutput
      ] as const
      const incremental = infer(components, INFER_OPTIONS) as Component<AgentView, unknown>
      assertAgentRefinement(completeAgent(components, INFER_OPTIONS), incremental, log)
    }), { numRuns: 100 })
  })
})
