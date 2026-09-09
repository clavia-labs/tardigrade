import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { actor } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { createHost } from "@clavia/tardigrade-host/host"
import { agentMethods, budget, codeMode, infer, nativeOutput, tool } from "../index"
import { jsSandboxFor } from "@clavia/tardigrade-code/sandbox/defaults"
import { Infer, NativeOutputSupport, type InferRequest } from "../inference/contract"
import { usageIn } from "../inference/usage"
import type { Action, ToolCall } from "../log/events"
import { renderMessages } from "../projection/messages"
import { compactionReactor, keepFromIndex } from "../component/compaction"
import { boundaryOf } from "../output/boundary"
import { cancellationRequested } from "@clavia/tardigrade-core/interaction/cancellation"
import type { AgentComponent, InferOptions } from "./composition"
import type { AgentR } from "./turn"

const MODEL = { models: { default: { provider: "test", model_id: "batch" }, allow: "*" } } as const
const ROOT = "ag.root"
const TURN = "m1"
const call = (callId: string, name = "read"): ToolCall => ({ callId, name, arguments: { path: callId } })
const batch = (...calls: [ToolCall, ...ToolCall[]]): Action => ({ kind: "calls", calls, usage: { promptTokens: 100, completionTokens: 20, costUsd: 0.01 } })
const spec = { name: "read", description: "Read a file.", inputSchema: {} }

const setup = (
  components: ReadonlyArray<AgentComponent<never> | AgentComponent<AgentR>>,
  mind: (request: InferRequest, key?: string) => Action,
  options: InferOptions = {},
  seed: ReadonlyArray<Event> = []
) => {
  const assembled = actor({ name: "batch-agent", methods: agentMethods, components: [infer([...components, nativeOutput], { ...MODEL, ...options })] })
  const host = createHost<AgentR | NativeOutputSupport>({
    actorName: "batch-agent",
    actorFor: () => assembled,
    layersFor: () => Layer.mergeAll(
      KeyValueStore.layerMemory,
      jsSandboxFor({}),
      Layer.succeed(Infer, { react: (request, key) => Effect.sync(() => mind(request, key)) }),
      Layer.succeed(NativeOutputSupport, { withTools: true })
    )
  })
  if (seed.length > 0) host.seed(ROOT, seed)
  return {
    host,
    read: () => host.read(ROOT),
    start: async () => {
      await host.commitRoot(host.self(ROOT), { type: "MessageReceived", id: TURN, text: "Read the files", at: 1 })
      await host.drive()
    }
  }
}

const complete = (): Action => ({ kind: "complete", output: "done", usage: { promptTokens: 50, completionTokens: 5, costUsd: 0.005 } })

describe("tool batches", () => {
  test("default dispatch overlaps calls and waits for every result before inference", async () => {
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const bothStarted = Promise.withResolvers<void>()
    const started: string[] = []
    const keys: Array<string | undefined> = []
    const run = setup([tool({ spec, run: (_input, context) => Effect.promise(async () => {
      started.push(context.callId)
      if (started.length === 2) bothStarted.resolve()
      await (context.callId === "lease" ? first.promise : second.promise)
      return context.callId
    }) })], (request, key) => {
      keys.push(key)
      if (keys.length === 1) return { ...batch(call("lease"), call("amendment")), text: "Reading both files." }
      expect(request.trajectory.filter((event) => event.type === "ToolReturned")).toHaveLength(2)
      return complete()
    })
    const driving = run.start()
    try {
      await bothStarted.promise
      expect(started).toEqual(["lease", "amendment"])
      second.resolve()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(keys).toHaveLength(1)
      expect(run.read().filter((event) => event.type === "ToolReturned").map((event) => event.callId)).toEqual(["amendment"])
    } finally {
      first.resolve()
      second.resolve()
      await driving
    }
    expect(keys).toEqual(["m1/infer/0", "m1/infer/1"])
    expect(usageIn(run.read(), TURN)).toMatchObject({ promptTokens: 150, completionTokens: 25, costUsd: 0.015 })
    expect(renderMessages(run.read()).filter((message) => message.role !== "user")).toEqual([
      { role: "assistant", content: "Reading both files.", toolCalls: [
        { id: "lease", name: "read", arguments: '{"path":"lease"}' },
        { id: "amendment", name: "read", arguments: '{"path":"amendment"}' }
      ] },
      { role: "tool", toolCallId: "amendment", content: '"amendment"' },
      { role: "tool", toolCallId: "lease", content: '"lease"' },
      { role: "assistant", content: "done" }
    ])
  })

  test.each(["root", "tool"] as const)("the %s concurrency limit queues every excess call", async (surface) => {
    let active = 0
    let peak = 0
    const order: string[] = []
    const run = setup([tool({
      spec,
      ...(surface === "tool" ? { concurrency: 1 } : {}),
      run: (_input, context) => Effect.promise(async () => {
        active += 1
        peak = Math.max(peak, active)
        order.push(context.callId)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active -= 1
        return context.callId
      })
    })], (request) => {
      const instruction = surface === "root" ? request.system : request.tools[0]!.description
      expect(instruction).toContain("at most 1 pending call")
      return request.trajectory.some((event) => event.type === "ToolCalled") ? complete() : batch(call("z"), call("a"), call("b"))
    }, surface === "root" ? { toolConcurrency: 1 } : {})
    await run.start()
    expect(peak).toBe(1)
    expect(order).toEqual(["z", "a", "b"])
    expect(run.read().filter((event) => event.type === "ToolReturned")).toHaveLength(3)
  })

  test("replay reuses committed results and runs only unfinished calls", async () => {
    const hold = Promise.withResolvers<void>()
    const bothStarted = Promise.withResolvers<void>()
    let started = 0
    const original = setup([tool({ spec, run: (_input, context) => Effect.promise(async () => {
      started += 1
      if (started === 2) bothStarted.resolve()
      if (context.callId === "second") await hold.promise
      return context.callId
    }) })], (request) => request.trajectory.some((event) => event.type === "ToolCalled") ? complete() : batch(call("first"), call("second")))
    const driving = original.start()
    try {
      await bothStarted.promise
      await new Promise((resolve) => setTimeout(resolve, 10))
      const saved = original.read()
      expect(saved.filter((event) => event.type === "ToolReturned").map((event) => event.callId)).toEqual(["first"])
      const rerun: string[] = []
      const recovered = setup([tool({ spec, run: (_input, context) => Effect.sync(() => {
        rerun.push(context.callId)
        return context.callId
      }) })], (request, key) => {
        expect(key).toBe("m1/infer/1")
        expect(request.trajectory.filter((event) => event.type === "ToolReturned")).toHaveLength(2)
        return complete()
      }, {}, saved)
      await recovered.host.wake(ROOT)
      await recovered.host.drive()
      expect(rerun).toEqual(["second"])
      expect(boundaryOf(recovered.read(), TURN)?.kind).toBe("completed")
    } finally {
      hold.resolve()
      await driving
    }
  })

  test("duplicate IDs reject the whole response before dispatch", async () => {
    let ran = 0
    const run = setup([tool({ spec, run: () => Effect.sync(() => ++ran) })], () => batch(call("same"), call("same")))
    await run.start()
    expect(ran).toBe(0)
    expect(run.read().filter((event) => event.type === "ToolCalled")).toHaveLength(0)
    expect(boundaryOf(run.read(), TURN)).toMatchObject({ kind: "failed", error: 'duplicate tool call ID "same" within turn "m1"' })
    expect(usageIn(run.read(), TURN).promptTokens).toBe(100)
  })

  test("cancellation settles every open batch call and excludes late results", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let count = 0
    let inferred = 0
    const run = setup([tool({ spec, run: () => Effect.promise(async () => {
      count += 1
      if (count === 2) started.resolve()
      await release.promise
      return "late"
    }) })], () => {
      inferred += 1
      return batch(call("a"), call("b"))
    })
    const driving = run.start()
    try {
      await started.promise
      await run.host.commitRoot(run.host.self(ROOT), cancellationRequested({
        request: "cancel-1", invocation: { method: "message", id: TURN, epoch: 0 }, cause: "requested", at: 2
      }))
      await driving
      expect(inferred).toBe(1)
      expect(run.read().filter((event) => event.type === "ToolReturned").map((event) => event.result)).toEqual([{ error: "cancelled" }, { error: "cancelled" }])
      expect(run.read().filter((event) => event.type === "TurnCancelled")).toHaveLength(1)
    } finally {
      release.resolve()
      await driving
    }
  })

  test("an unknown tool and a returned error each settle without losing sibling results", async () => {
    const run = setup([tool({ spec, run: () => Effect.succeed({ error: "file missing" }) })], (request) =>
      request.trajectory.some((event) => event.type === "ToolCalled") ? complete() : batch(call("missing", "unknown"), call("known")))
    await run.start()
    const results = run.read().filter((event) => event.type === "ToolReturned")
    expect(results).toHaveLength(2)
    expect(results[0]!.result).toMatchObject({ error: "unknown tool: unknown. Call one of: read." })
    expect(results[1]!.result).toEqual({ error: "file missing" })
    expect(boundaryOf(run.read(), TURN)?.kind).toBe("completed")
  })

  test("a batch crossing the budget runs its allowed prefix and answers every call", async () => {
    const ran: string[] = []
    const run = setup([budget([tool({ spec, run: (_input, context) => Effect.sync(() => {
      ran.push(context.callId)
      return context.callId
    }) })], { limit: 2 })], (request) => request.trajectory.some((event) => event.type === "ToolCalled") ? complete() : batch(call("1"), call("2"), call("3")))
    await run.start()
    expect(ran).toEqual(["1", "2"])
    expect(run.read().filter((event) => event.type === "ToolReturned")).toHaveLength(3)
    expect(run.read().filter((event) => event.type === "BudgetExhausted")).toHaveLength(1)
  })

  test("code mode retains and settles every execute call", async () => {
    const run = setup([codeMode()], (request) => request.trajectory.some((event) => event.type === "ToolCalled") ? complete() : batch(
      { callId: "code-1", name: "execute", arguments: { code: "return 1" } },
      { callId: "code-2", name: "execute", arguments: { code: "return 2" } }
    ))
    await run.start()
    expect(run.read().filter((event) => event.type === "ToolReturned").map((event) => event.result)).toEqual([{ result: 1 }, { result: 2 }])
  })

  test("a budget wall lets admitted code finish beside refused batch calls", async () => {
    const run = setup([budget([codeMode(), tool({ spec, run: () => Effect.succeed("read") })], { limit: 1 })], (request) =>
      request.trajectory.some((event) => event.type === "ToolCalled") ? complete() : batch(
        { callId: "code", name: "execute", arguments: { code: "return 42" } }, call("refused")
      ))
    await run.start()
    expect(run.read().find((event) => event.type === "ToolReturned" && event.callId === "code")?.result).toEqual({ result: 42 })
    expect(run.read().filter((event) => event.type === "ToolReturned")).toHaveLength(2)
  })

  test("compaction keeps a complete batch even when a checkpoint names a later call", () => {
    const history: Event[] = [
      { type: "MessageReceived", id: TURN, text: "work", at: 0 },
      { type: "ToolCalled", turn: TURN, callId: "a", name: "read", arguments: {}, batchId: "m1/infer/0", batchIndex: 0, at: 1 },
      { type: "ToolCalled", turn: TURN, callId: "b", name: "read", arguments: {}, batchId: "m1/infer/0", batchIndex: 1, at: 1 },
      { type: "ToolReturned", turn: TURN, callId: "b", result: "x".repeat(500), at: 2 }
    ]
    const reactor = compactionReactor({ contextWindowTokens: 100, fireRatio: 0.5, keepRatio: 0.1 })
    expect(reactor(history)).toEqual([])
    history.push({ type: "ToolReturned", turn: TURN, callId: "a", result: "x".repeat(500), at: 3 })
    const transitions = reactor(history)
    expect(transitions).toHaveLength(1)
    expect(transitions[0]!.input).toMatchObject({ keepFrom: 'c:["m1","a"]' })
    expect(keepFromIndex(history, 'c:["m1","b"]')).toBe(1)
    history.push({ type: "CompactionCompleted", keepFrom: 'c:["m1","b"]', summary: "Earlier work", at: 4 })
    expect(renderMessages(history).find((message) => message.toolCalls)?.toolCalls?.map((entry) => entry.id)).toEqual(["a", "b"])
  })

  test.each([0, -1, 1.5, Infinity, NaN])("invalid concurrency %s fails at construction", (value) => {
    expect(() => infer([nativeOutput], { ...MODEL, toolConcurrency: value })).toThrow("tool concurrency")
    expect(() => infer([tool({ spec, concurrency: value, run: () => Effect.void }), nativeOutput], MODEL)).toThrow("tool concurrency")
  })
})
