import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { KeyValueStore } from "effect/unstable/persistence"
import { testInferenceLayer } from "@clavia/tardigrade-agent/fixtures/model"
import { alarmFiredForLog, deadlineCancellationEventsAt } from "@clavia/tardigrade-core/interaction/timeout"
import {
  actor,
  actorCall,
  actorContractErrors,
  componentContractOf,
  DEFAULT_ACTOR_METHOD_TIMEOUT_MS,
  threadTarget,
  validateActor,
  withComponentContract,
  type ActorContract
} from "tardie/core"
import {
  agentMethods,
  agents,
  budget,
  compact,
  infer,
  messages,
  nativeOutput,
  outputValidateOnce,
  system,
  tool,
  tools,
  type InferOptions
} from "tardie/agent"
import { fetch, workspace } from "tardie/code"
import { createBunHost } from "tardie/bun"
import type { Action } from "tardie/log/events"
import { actorScenario, ROOT_THREAD } from "./harness"

const ONE_HOUR_MS = 3_600_000
const TEST_MODEL = { models: { default: { provider: "test", model_id: "test-model" }, allow: "*" } } as const
const QUESTION = { text: "Research durable agent architectures and compare their tradeoffs. Cite sources." }

const papers = tool({
  spec: {
    name: "search_papers",
    description: "Search OpenAlex for paper titles, years, and links",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 5 } },
      required: ["query", "limit"],
      additionalProperties: false
    }
  },
  run: () => Effect.succeed([])
}, "", { name: "papers" })

// researcherComponents composes the README researcher. The papers component takes its own name because the package tools already use "tools".
const researcherComponents = (options: InferOptions = {}) => [infer([
  system("You are a research assistant. Investigate the question and cite your sources."),
  papers,
  compact(messages(), { triggerRatio: 0.8, retainRatio: 0.5 }),
  budget(tools([
    fetch(),
    agents(),
    workspace()
  ]), {
    limit: 12,
    usage: ({ calls }) => calls.length,
    onExhausted: (reason, settle) => settle({ error: reason })
  }),
  outputValidateOnce
], options)] as const

const researcher = actor({
  name: "researcher",
  methods: agentMethods,
  components: researcherComponents()
})

// longMessage is the stock message method re-declared with a one hour deadline.
const longMessage = { ...agentMethods.message, timeoutMs: ONE_HOUR_MS }

// messageSeam reports how an actor's contract resolves its message method.
const messageSeam = (definition: { readonly contract: ActorContract }) => ({
  handling: definition.contract.methods.find((method) => method.name === "message")?.handling,
  undeclaredHandlers: definition.contract.undeclaredHandlers.length
})

describe("the stock agent message deadline", () => {
  test("the README researcher's message method has the five minute default deadline", () => {
    expect(DEFAULT_ACTOR_METHOD_TIMEOUT_MS).toBe(300_000)
    expect(researcher.methods.message).toBe(agentMethods.message)
    expect(researcher.methods.message.timeoutMs).toBe(DEFAULT_ACTOR_METHOD_TIMEOUT_MS)
    expect(messageSeam(researcher)).toEqual({ handling: ["local"], undeclaredHandlers: 0 })
  })

  test("a caller cannot ask for a longer message deadline", async () => {
    const host = await createBunHost({
      actor: researcher,
      storage: ":memory:",
      layersFor: () => Layer.mergeAll(
        KeyValueStore.layerMemory,
        FetchHttpClient.layer,
        testInferenceLayer({ react: () => Effect.die("the refused call never reaches the model") })
      )
    })
    try {
      const thread = await host.allocateRootThread({ instance: "researcher", name: "main" })
      await expect(thread.methods.message(QUESTION, { key: "architecture-research", timeoutMs: ONE_HOUR_MS })).rejects.toThrow(
        "timeoutMs cannot exceed the method's declared 300000ms"
      )
      expect(() => actorCall([], {
        id: "architecture-research",
        target: threadTarget(researcher, "researcher", "main"),
        method: "message",
        input: QUESTION,
        timeoutMs: ONE_HOUR_MS
      })).toThrow("timeoutMs cannot exceed the method's declared 300000ms")
    } finally {
      await host.close()
    }
  })

  test("a turn whose tool runs past the deadline is cancelled and returns no answer", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const runTests: Action = { kind: "calls", calls: [{ callId: "c1", name: "run_tests", arguments: {} }], usage: { promptTokens: 100, completionTokens: 20 } }
    const answer: Action = { kind: "complete", output: "all tests pass", usage: { promptTokens: 100, completionTokens: 5 } }
    const coder = actor({
      name: "coder",
      methods: agentMethods,
      components: [infer([
        system("You are a coding agent. Run the test suite and report the result."),
        tool({
          spec: { name: "run_tests", description: "Run the full test suite.", inputSchema: { type: "object", properties: {} } },
          run: () => Effect.promise(async () => {
            started.resolve()
            await release.promise
            return "all tests pass"
          })
        }),
        nativeOutput
      ], TEST_MODEL)]
    })
    const scenario = actorScenario(coder, (request) =>
      Promise.resolve(request.trajectory.some((event) => event.type === "ToolReturned") ? answer : runTests))
    const turn = await scenario.enqueue("Run the test suite.")
    const driving = scenario.drive()
    try {
      await started.promise
      const log = scenario.host.read(ROOT_THREAD)
      const received = log.find((event) => event.type === "MessageReceived")!
      const deadlineAt = (received.call as { readonly deadlineAt: number }).deadlineAt
      expect(deadlineAt - Number(received.at)).toBe(DEFAULT_ACTOR_METHOD_TIMEOUT_MS)
      // A platform alarm commits the crossed deadline with its cancellation (platform/bun/src/host.test.ts, "an alarm commits its deadline cancellation atomically").
      for (const event of [
        alarmFiredForLog(log, { scheduledFor: deadlineAt, at: deadlineAt }),
        ...deadlineCancellationEventsAt(log, coder.methods, deadlineAt)
      ]) await scenario.host.commitRoot(scenario.host.self(ROOT_THREAD), event)
      await driving

      const settled = scenario.host.read(ROOT_THREAD)
      expect(settled.filter((event) => event.type === "TurnCancelled")).toMatchObject([{ turn, cause: "deadline", deadlineAt }])
      expect(settled.filter((event) => event.type === "ToolReturned").map((event) => event.result)).toEqual([{ error: "cancelled" }])
      expect(settled.filter((event) => event.type === "TurnCompleted")).toEqual([])
      expect(coder.methods.message.state(settled, { method: "message", id: turn, epoch: 0 })).toEqual({ status: "cancelled", cause: "deadline", deadlineAt })
      expect(scenario.result(turn).output).toBeUndefined()
    } finally {
      release.resolve()
      await driving
    }
  })

  test("a re-declared message method fails the contract check unless the infer contract is rewritten by hand", () => {
    const methods = { ...agentMethods, message: longMessage }
    const [root] = researcherComponents()
    const redeclared = actor({ name: "researcher", methods, components: [root] })
    expect(redeclared.methods.message.timeoutMs).toBe(ONE_HOUR_MS)
    expect(messageSeam(redeclared)).toEqual({ handling: [], undeclaredHandlers: 1 })
    expect(actorContractErrors(redeclared.contract)).toEqual(expect.arrayContaining([
      'method "message" has no handler',
      "1 handled method(s) are absent from the actor surface"
    ]))
    expect(() => validateActor(redeclared)).toThrow('method "message" has no handler')

    const contract = componentContractOf(root)
    const relabelled = withComponentContract(root, {
      ...contract,
      handles: contract.handles.map((handled) => handled.method === agentMethods.message ? { ...handled, method: longMessage } : handled)
    })
    const rewritten = actor({ name: "researcher", methods, components: [relabelled] })
    expect(messageSeam(rewritten)).toEqual({ handling: ["local"], undeclaredHandlers: 0 })
    expect(actorContractErrors(rewritten.contract)).toEqual(actorContractErrors(researcher.contract))
    expect(actorCall([], {
      id: "architecture-research",
      target: threadTarget(rewritten, "researcher", "main"),
      method: "message",
      input: QUESTION,
      timeoutMs: ONE_HOUR_MS
    }).transitions).toHaveLength(1)
  })

  // The infer option name is one candidate surface. The requirement is the outcome: a longer stock message deadline that passes the contract check without a hand-written component contract.
  test.failing("an agent declares a longer deadline for its stock message method through a supported option", () => {
    const options = { ...TEST_MODEL, message: longMessage }
    const configured = actor({
      name: "researcher",
      methods: { ...agentMethods, message: longMessage },
      components: researcherComponents(options)
    })
    expect(configured.methods.message.timeoutMs).toBe(ONE_HOUR_MS)
    expect(messageSeam(configured)).toEqual({ handling: ["local"], undeclaredHandlers: 0 })
  })
})
