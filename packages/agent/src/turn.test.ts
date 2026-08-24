import { describe, expect, test } from "bun:test"
import { Clock, Effect, Layer, Ref } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import type { Event } from "@clavia/tardigrade-core/event"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/event-log"
import { send, settleActor, transition } from "@clavia/tardigrade-core/actor"
import { definePackage, type Package } from "@clavia/tardigrade-code/packages"
import { guestBindings, Sandbox, type Bindings } from "@clavia/tardigrade-code/sandbox"
import { Router } from "@clavia/tardigrade-core/router"
import { parseActorId } from "@clavia/tardigrade-core/communication/endpoint"
import { Facets } from "@clavia/tardigrade-core/facets"
import { Self } from "@clavia/tardigrade-core/actor"
import { Infer, receive } from "./turn"
import { modelRequest } from "./request"
import { NativeOutputSupport, type InferRequest } from "./runtime/infer"
import { turnFailed } from "./events"
import type { AgentComponent } from "./runtime/agent"
import type { OutputFallback } from "./output"
import {
  actor,
  budget,
  codeMode,
  compaction,
  fingerprintOf,
  infer,
  nativeOutput,
  output,
  outputValidateOnce,
  repairFallback,
  VALIDATE_ONCE_FALLBACK,
  NATIVE_MODE,
  outputOf,
  outputRepair,
  outputRepairFor,
  outputRetryRequested,
  reply,
  toolList
} from "./index"

const TEST_MODEL = { provider: "test", default_model: "test-model" } as const

// The default assembly over a stated scope. The infer root contains model inference, call routing,
// and every child transition in one projection.
const agentWith = (packages: ReadonlyArray<Package>) =>
  actor(infer([codeMode(packages), reply, budget, compaction(), nativeOutput], TEST_MODEL))
const rlmAgent = agentWith([])
const rootReactor = rlmAgent.reactors[0]!
// The agent end to end: the model writes code, the code calls packages, every call is recorded,
// and the turn completes. The sandbox test binding runs real JS with the package objects in
// scope; no isolation is needed to test the machinery.

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

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: ReadonlyArray<string>
) => (...bindings: ReadonlyArray<unknown>) => Promise<unknown>

const jsSandbox = Layer.succeed(Sandbox, {
  run: (code: string, bindings: Bindings) =>
    Effect.promise(async () => {
      try {
        const scope = guestBindings(bindings)
        const names = Object.keys(scope)
        const body = new AsyncFunction(...names, code)
        return { result: await body(...names.map((name) => scope[name])) }
      } catch (e) {
        return { error: String(e) }
      }
    })
})

const zoho = (spies: { insert: number; search: number }): Package => definePackage({
  name: "zohorecruit",
  description: "the ATS",
  methods: {
    insert_record: () => {
      spies.insert += 1
      return Effect.succeed({ id: "jd-91" })
    },
    search_records: () => {
      spies.search += 1
      return Effect.succeed({ hits: 3 })
    }
  }
})

// No other actors exist in these tests, so sending is a no-op.
const noRouter = Layer.mergeAll(
  Layer.succeed(Facets, { read: () => Effect.succeed([]) }),
  Layer.succeed(Router, {
    send: () => Effect.void
  }),
  Layer.succeed(Self, parseActorId("test-agent")),
  Layer.succeed(NativeOutputSupport, { withTools: true })
)

const readLog = Effect.flatMap(EventLog, (log) => log.read)
const run = <A, R>(effect: Effect.Effect<A, never, R>, layers: Layer.Layer<R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layers)) as Effect.Effect<A>)

const CODE = `const record = await zohorecruit.insert_record({ title: "IC design lead" })
const found = await zohorecruit.search_records({ q: "tapeout" })
return { jd_record_id: record.id, hits: found.hits }`

// The model: write the code once, then complete after reading the return.
const codeThenComplete = (count: { calls: number }) =>
  Layer.succeed(Infer, {
    react: ({ trajectory }: { trajectory: ReadonlyArray<Event> }) => {
      count.calls += 1
      const returned = trajectory.some((e) => e.type === "ToolReturned")
      return Effect.succeed(
        returned
          ? { kind: "complete" as const, output: "created jd-91, 3 candidates found" }
          : { kind: "call" as const, callId: "t1", name: "execute", arguments: { code: CODE } }
      )
    }
  })

describe("the agent with execute as the only tool", () => {
  test("the model's code runs with every package call recorded", async () => {
    const count = { calls: 0 }
    const spies = { insert: 0, search: 0 }
    const agent = agentWith([zoho(spies)])
    const layers = Layer.mergeAll(
      KeyValueStore.layerMemory,
      memoryLog(),
      codeThenComplete(count),
      jsSandbox,
      noRouter
    )
    const events = await run(
      Effect.gen(function* () {
        yield* receive(agent, { id: "m1", text: "add the JD and search candidates" })
        return yield* readLog
      }),
      layers
    )
    expect(events.map((e) => e.type)).toEqual([
      "MessageReceived",
      "ModelResolved",
      "ModelCalled",
      "ToolCalled",
      "CodeDispatched",
      "PackageCalled",
      "PackageReturned",
      "PackageCalled",
      "PackageReturned",
      "CodeSettled",
      "ToolReturned",
      "ModelCalled",
      "TurnCompleted",
      "ReplyDelivered"
    ])
    expect(events[5]).toMatchObject({ callId: "t1.0", name: "zohorecruit.insert_record" })
    expect(events[9]).toMatchObject({ result: { jd_record_id: "jd-91", hits: 3 } })
    expect(spies).toEqual({ insert: 1, search: 1 })
    expect(count.calls).toBe(2)
    expect(rootReactor(events)).toHaveLength(0)
  })

  test("a spilled settle answers with its pointer, never an empty result", async () => {
    // Over the spill bound the settle carries a pointer instead of the value. Answering the call from
    // `result` alone hands the model `{}`: it learns neither what its code computed nor that a
    // ref holds it, so it re-runs the work. The pointer and its note are the result.
    const big = "y".repeat(20_000)
    const spilled: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m1", text: "read the contract", at: 1 },
      { type: "ToolCalled", callId: "t1", name: "execute", arguments: { code: "return await docs.read()" }, turn: "m1", at: 2 },
      { type: "CodeDispatched", execId: "t1", code: "return await docs.read()", turn: "m1", at: 3 },
      {
        type: "CodeSettled",
        execId: "t1",
        tmp: "t1.result",
        size: big.length,
        preview: big.slice(0, 500),
        note: "full value: workspace.read({ref: 't1.result'})",
        turn: "m1",
        at: 4
      }
    ]
    const events = await run(readLog, memoryLog(spilled))
    const [answer] = rootReactor(events)
    expect(answer).toBeDefined()
    // Every reactor's `act` is typed against the agent's whole environment, so a settle that only
    // reads the log still states it. Providing it is what proves the settle never reaches for the
    // sandbox or the model to answer from a pointer.
    const returned = await run(
      answer!.act(answer!.input as never),
      Layer.mergeAll(KeyValueStore.layerMemory, memoryLog(), codeThenComplete({ calls: 0 }), jsSandbox, noRouter)
    )
    expect(returned[0]!.type).toBe("ToolReturned")
    const result = (returned[0] as unknown as { result: { result: Record<string, unknown> } }).result.result
    expect(result.tmp).toBe("t1.result")
    expect(result.size).toBe(big.length)
    expect(result.note).toBe("full value: workspace.read({ref: 't1.result'})")
    expect(String(result.preview)).toHaveLength(500)
  })

  test("a committed package call replays: the insert is never re-executed", async () => {
    // The shape a crash leaves behind: the insert's pair is committed, the search never ran. The
    // re-settle re-runs the body from the top, replays the insert from the log, and runs only
    // the search live. The world sees one insert, ever.
    const crashed: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m1", text: "add the JD and search candidates", at: 1 },
      { type: "ToolCalled", callId: "t1", name: "execute", arguments: { code: CODE }, turn: "m1", at: 2 },
      { type: "CodeDispatched", execId: "t1", code: CODE, turn: "m1", at: 3 },
      { type: "PackageCalled", callId: "t1.0", name: "zohorecruit.insert_record", arguments: { title: "IC design lead" }, turn: "m1", at: 4 },
      { type: "PackageReturned", callId: "t1.0", result: { id: "jd-91" }, turn: "m1", at: 5 }
    ]
    const count = { calls: 0 }
    const spies = { insert: 0, search: 0 }
    const layers = Layer.mergeAll(KeyValueStore.layerMemory, memoryLog(crashed), codeThenComplete(count), jsSandbox, noRouter)
    const events = await run(
      Effect.gen(function* () {
        yield* settleActor(agentWith([zoho(spies)]))
        return yield* readLog
      }),
      layers
    )
    expect(events.at(-2)).toMatchObject({ type: "TurnCompleted" })
    expect(spies).toEqual({ insert: 0, search: 1 })
    expect(events.filter((e) => e.type === "PackageCalled").length).toBe(2)
  })

  test("a thrown body settles as an error the model reads", async () => {
    const count = { calls: 0 }
    const layers = Layer.mergeAll(
    KeyValueStore.layerMemory,
    memoryLog(),
      Layer.succeed(Infer, {
        react: ({ trajectory }: { trajectory: ReadonlyArray<Event> }) => {
          count.calls += 1
          const returned = trajectory.find((e) => e.type === "ToolReturned")
          return Effect.succeed(
            returned
              ? { kind: "fail" as const, error: "the body is broken" }
              : { kind: "call" as const, callId: "t1", name: "execute", arguments: { code: "throw new Error('boom')" } }
          )
        }
      }),
      jsSandbox,
      noRouter
    )
    const events = await run(
      Effect.gen(function* () {
        yield* receive(rlmAgent, { id: "m1", text: "run it" })
        return yield* readLog
      }),
      layers
    )
    const returned = events.find((e) => e.type === "ToolReturned") as { result?: { error?: string } }
    expect(String(returned.result?.error)).toContain("boom")
    expect(events.at(-2)).toMatchObject({ type: "TurnFailed" })
  })

  test("two messages committed before any settle each get their own turn, in order", async () => {
    // The race that cross-wired run 3: concurrent ingress lands both messages on the log before
    // a settle runs. The stamped fold serves them as two turns in arrival order; each answer
    // carries its own turn.
    const queued: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m1", text: "first ask", at: 1 },
      { type: "MessageReceived", id: "m2", text: "second ask", at: 2 }
    ]
    const echoHead = Layer.succeed(Infer, {
      react: ({ trajectory }: { trajectory: ReadonlyArray<Event> }) => {
        let text = ""
        for (const e of trajectory) if (e.type === "MessageReceived") text = String((e as { text?: unknown }).text)
        return Effect.succeed({ kind: "complete" as const, output: `answer to: ${text}` })
      }
    })
    const layers = Layer.mergeAll(
    KeyValueStore.layerMemory,
    memoryLog(queued), echoHead, jsSandbox, noRouter)
    const events = await run(
      Effect.gen(function* () {
        yield* settleActor(rlmAgent)
        return yield* readLog
      }),
      layers
    )
    const terminals = events.filter((e) => e.type === "TurnCompleted") as ReadonlyArray<{ turn?: string; output?: string }>
    expect(terminals.map((t) => ({ turn: t.turn, output: t.output }))).toEqual([
      { turn: "m1", output: "answer to: first ask" },
      { turn: "m2", output: "answer to: second ask" }
    ])
    const replies = events.filter((e) => e.type === "ReplyDelivered") as ReadonlyArray<{ turn?: string }>
    expect(replies.map((r) => r.turn)).toEqual(["m1", "m2"])
  })

  test("three dead model attempts settle the turn failed", async () => {
    // Three marks with nothing after them: three inferences died before committing anything. The
    // fourth settle gives up instead of asking again. The model is never called.
    const crashed: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m1", text: "hi", at: 1 },
      { type: "ModelCalled", callId: "m1/infer/0", turn: "m1", at: 2 },
      { type: "ModelCalled", callId: "m1/infer/1", turn: "m1", at: 3 },
      { type: "ModelCalled", callId: "m1/infer/2", turn: "m1", at: 4 }
    ]
    const count = { calls: 0 }
    const layers = Layer.mergeAll(KeyValueStore.layerMemory, memoryLog(crashed), codeThenComplete(count), jsSandbox, noRouter)
    const events = await run(
      Effect.gen(function* () {
        yield* settleActor(rlmAgent)
        return yield* readLog
      }),
      layers
    )
    expect(events.at(-2)).toMatchObject({ type: "TurnFailed" })
    expect(count.calls).toBe(0)
  })

  test("a redelivered message appends nothing", async () => {
    const count = { calls: 0 }
    const layers = Layer.mergeAll(
    KeyValueStore.layerMemory,
    memoryLog(),
      Layer.succeed(Infer, {
        react: () => {
          count.calls += 1
          return Effect.succeed({ kind: "complete" as const, output: "ok" })
        }
      }),
      jsSandbox,
      noRouter
    )
    const events = await run(
      Effect.gen(function* () {
        yield* receive(rlmAgent, { id: "m1", text: "hi" })
        yield* receive(rlmAgent, { id: "m1", text: "hi" })
        return yield* readLog
      }),
      layers
    )
    expect(events.filter((e) => e.type === "MessageReceived").length).toBe(1)
    expect(count.calls).toBe(1)
  })

  test("the consequence records the action's spend and who was called", async () => {
    const spent = {
      promptTokens: 10,
      completionTokens: 4,
      costUsd: 0.01,
      costSource: "provider" as const,
      provider: "vercel-ai-gateway",
      model: "anthropic/claude-sonnet-4.6"
    }
    const layers = Layer.mergeAll(
      KeyValueStore.layerMemory,
      memoryLog(),
      Layer.succeed(Infer, {
        react: () => Effect.succeed({ kind: "complete" as const, output: "ok", usage: spent })
      }),
      jsSandbox,
      noRouter
    )
    const events = await run(
      Effect.gen(function* () {
        yield* receive(rlmAgent, { id: "m1", text: "hi" })
        return yield* readLog
      }),
      layers
    )
    expect(events.map((e) => e.type)).toEqual([
      "MessageReceived",
      "ModelResolved",
      "ModelCalled",
      "TurnCompleted",
      "ReplyDelivered"
    ])
    expect(events.find((e) => e.type === "TurnCompleted")).toMatchObject({
      turn: "m1",
      usage: spent
    })
  })

  test("provider retry exhaustion records a resumable failure with its policy", async () => {
    const retry = { throttleRetryDelaysMs: [100], stream: { firstChunkMs: 1, idleMs: 2, totalMs: 3 } }
    const layers = Layer.mergeAll(
      KeyValueStore.layerMemory,
      memoryLog(),
      Layer.succeed(Infer, {
        react: () =>
          Effect.succeed({
            kind: "fail" as const,
            error: "model inference retries exhausted after 2 attempts: timeout",
            failure: { cause: "inference_attempts_exhausted" as const, attempts: 2, policy: retry }
          })
      }),
      jsSandbox,
      noRouter
    )
    const events = await run(
      Effect.gen(function* () {
        yield* receive(rlmAgent, { id: "m1", text: "hi" })
        return yield* readLog
      }),
      layers
    )

    expect(events.find((event) => event.type === "TurnFailed")).toMatchObject({
      turn: "m1",
      cause: "inference_attempts_exhausted",
      attempts: 2,
      attemptKey: "m1/infer/0",
      policy: retry,
      usage: {}
    })
  })
})

// The scout contract from a research task, and the two results a model gives: the double-encoded
// one that broke a prod run, then the correct one after it reads its own errors.
const SCOUT = output({
  name: "scout",
  schema: {
    type: "object",
    properties: {
      aspects: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, description: { type: "string" } },
          required: ["name", "description"],
          additionalProperties: false
        }
      }
    },
    required: ["aspects"],
    additionalProperties: false
  }
})
const GOOD_ANSWER = { aspects: [{ name: "grader nondeterminism", description: "how graders drift" }] }
const BAD_ANSWER = JSON.stringify({ aspects: JSON.stringify(GOOD_ANSWER) })

// completedTurns names the turns whose corrected value landed, the same reading the render's
// history projection takes (request.ts, renderMessages).
const completedTurns = (log: ReadonlyArray<Event>): ReadonlySet<string> =>
  new Set(log.filter((e) => e.type === "TurnCompleted").map((e) => String((e as { turn?: unknown }).turn)))

// The stub binding states the mode it emulates, the way a real binding reports the mode it
// selected. Nothing synthesizes one: a declared-output result with no mode is an invariant error
// (runtime/infer.ts, completionOf).
const REPAIR_TWO = repairFallback({ attempts: 2 })

const repairAgent = (policy: Parameters<typeof outputRepairFor>[0] = {}) =>
  actor(infer([codeMode(), reply, budget, compaction(), outputRepairFor(policy)], TEST_MODEL))

describe("a turn that declares an output contract", () => {
  test("a conforming response completes the turn, and outputOf reads it back typed", async () => {
    const layers = Layer.mergeAll(
      memoryLog(),
      KeyValueStore.layerMemory,
      Layer.succeed(Infer, {
        react: () => Effect.succeed({ kind: "complete" as const, output: JSON.stringify(GOOD_ANSWER), mode: NATIVE_MODE })
      }),
      jsSandbox,
      noRouter
    )
    const events = await run(
      Effect.gen(function* () {
        yield* receive(rlmAgent, { id: "m1", text: "decompose this topic", output: SCOUT })
        return yield* readLog
      }),
      layers
    )
    expect(events.some((e) => e.type === "OutputRejected")).toBe(false)
    expect(outputOf(SCOUT, events, "m1")?.aspects[0]?.name).toBe("grader nondeterminism")
    // The ask records the declared policy: the contract's identity, its fingerprint, and the
    // fallback the assembly mounted, which is none here.
    const called = events.find((e) => e.type === "ModelCalled") as {
      output?: { contract?: string; fingerprint?: string; fallback?: unknown }
    }
    expect(called.output?.contract).toBe("scout")
    expect(called.output?.fingerprint).toBe(fingerprintOf(SCOUT))
    expect(called.output?.fallback).toBeUndefined()
    // The consequence records the mode the attempt actually ran in, which is what replay reads.
    const done = events.find((e) => e.type === "TurnCompleted") as { mode?: unknown; attemptKey?: string }
    expect(done.mode).toEqual({ kind: "native", name: "native" })
    expect(done.attemptKey).toBe("m1/infer/0")
  })

  test("real tool calls stay tool calls; the contract governs the response that ends the turn", async () => {
    const layers = Layer.mergeAll(
      memoryLog(),
      KeyValueStore.layerMemory,
      Layer.succeed(Infer, {
        react: ({ trajectory }: { trajectory: ReadonlyArray<Event> }) =>
          Effect.succeed(
            trajectory.some((e) => e.type === "ToolReturned")
              ? { kind: "complete" as const, output: JSON.stringify(GOOD_ANSWER), mode: NATIVE_MODE }
              : {
                  kind: "call" as const,
                  callId: "c1",
                  name: "execute",
                  arguments: { code: "return 1" },
                  mode: NATIVE_MODE
                }
          )
      }),
      jsSandbox,
      noRouter
    )
    const events = await run(
      Effect.gen(function* () {
        yield* receive(rlmAgent, { id: "m1", text: "decompose this topic", output: SCOUT })
        return yield* readLog
      }),
      layers
    )
    const called = events.filter((e) => e.type === "ToolCalled") as ReadonlyArray<{ name?: string; mode?: unknown }>
    expect(called.map((event) => event.name)).toEqual(["execute"])
    expect(called[0]?.mode).toEqual(NATIVE_MODE)
    expect(outputOf(SCOUT, events, "m1")).toEqual(GOOD_ANSWER)
  })

  test("a tool call under a declared contract must report its effective mode", async () => {
    const layers = Layer.mergeAll(
      memoryLog(),
      KeyValueStore.layerMemory,
      Layer.succeed(Infer, {
        react: () =>
          Effect.succeed({ kind: "call" as const, callId: "c1", name: "execute", arguments: { code: "return 1" } })
      }),
      jsSandbox,
      noRouter
    )
    const events = await run(
      Effect.gen(function* () {
        yield* receive(rlmAgent, { id: "m1", text: "decompose this topic", output: SCOUT })
        return yield* readLog
      }),
      layers
    )
    expect(events.some((event) => event.type === "ToolCalled")).toBe(false)
    expect(events.find((event) => event.type === "TurnFailed")).toMatchObject({ cause: "inference_error" })
  })

  test("the native implementation never asks again: a missed contract is the provider's violation", async () => {
    let asked = 0
    const layers = Layer.mergeAll(
      memoryLog(),
      KeyValueStore.layerMemory,
      Layer.succeed(Infer, {
        react: () => {
          asked += 1
          return Effect.succeed({ kind: "complete" as const, output: BAD_ANSWER, mode: NATIVE_MODE })
        }
      }),
      jsSandbox,
      noRouter
    )
    const events = await run(
      Effect.gen(function* () {
        yield* receive(rlmAgent, { id: "m1", text: "decompose this topic", output: SCOUT })
        return yield* readLog
      }),
      layers
    )
    expect(asked).toBe(1)
    expect(events.some((e) => e.type === "OutputRejected")).toBe(false)
    const failed = events.find((e) => e.type === "TurnFailed") as { error?: string; cause?: string; policy?: unknown }
    expect(failed.cause).toBe("output_contract_violation")
    expect(failed.error).toContain("aspects")
    expect(failed.policy).toMatchObject({ kind: "native", name: "native" })
  })

  test("prose under a contract is the same violation, never a second ask", async () => {
    const layers = Layer.mergeAll(
      memoryLog(),
      KeyValueStore.layerMemory,
      Layer.succeed(Infer, { react: () => Effect.succeed({ kind: "complete" as const, output: "here are the aspects", mode: NATIVE_MODE }) }),
      jsSandbox,
      noRouter
    )
    const events = await run(
      Effect.gen(function* () {
        yield* receive(rlmAgent, { id: "m1", text: "decompose this topic", output: SCOUT })
        return yield* readLog
      }),
      layers
    )
    expect(events.find((e) => e.type === "TurnFailed")).toMatchObject({ cause: "output_contract_violation" })
    expect((events.find((e) => e.type === "TurnFailed") as { error?: string }).error).toContain("not JSON")
  })
})

describe("the repair implementation", () => {
  test("a rejected response comes back with its reasons, and the correction completes the turn", async () => {
    const seen: Array<string> = []
    const layers = Layer.mergeAll(
      memoryLog(),
      KeyValueStore.layerMemory,
      Layer.succeed(Infer, {
        react: (request: InferRequest) => {
          const trajectory = request.trajectory
          // The correction is a real message, so the model reads why it was refused.
          const refused = trajectory.some((e) => e.type === "OutputRejected")
          seen.push(refused ? "corrected" : "first")
          // The fallback's instruction rides the output request, so it reaches the model only on
          // an attempt running as that fallback (request.ts, OutputRequest).
          expect(request.output?.system).toContain('conforming to the schema "scout"')
          expect(request.system).not.toContain("scout")
          return Effect.succeed(
            refused
              ? { kind: "complete" as const, output: JSON.stringify(GOOD_ANSWER), mode: REPAIR_TWO }
              : { kind: "complete" as const, output: BAD_ANSWER, mode: REPAIR_TWO }
          )
        }
      }),
      jsSandbox,
      noRouter
    )
    const events = await run(
      Effect.gen(function* () {
        yield* receive(repairAgent(), { id: "m1", text: "decompose this topic", output: SCOUT })
        return yield* readLog
      }),
      layers
    )
    expect(seen).toEqual(["first", "corrected"])
    const rejected = events.find((e) => e.type === "OutputRejected") as {
      contract?: string
      text?: string
      errors?: ReadonlyArray<string>
      attempt?: string
    }
    expect(rejected.contract).toBe("scout")
    expect(rejected.text).toBe(BAD_ANSWER)
    expect(rejected.errors?.join(" ")).toContain("aspects")
    // The rejection is a typed event of its own: no tool stands in for it.
    expect(events.some((e) => e.type === "ToolCalled")).toBe(false)
    expect(outputOf(SCOUT, events, "m1")).toEqual(GOOD_ANSWER)
  })

  test("the correction is a rendered exchange, and a later turn reads the corrected value alone", async () => {
    const rendered: Array<ReadonlyArray<{ readonly role: string; readonly content: string | null }>> = []
    const layers = Layer.mergeAll(
      memoryLog(),
      KeyValueStore.layerMemory,
      Layer.succeed(Infer, {
        react: (request: InferRequest) => {
          rendered.push(modelRequest(request.trajectory, request, request.context ?? {}).messages)
          const owed = request.trajectory.some((e) => e.type === "OutputRejected" && !completedTurns(request.trajectory).has(String((e as { turn?: unknown }).turn)))
          return Effect.succeed(
            owed || request.trajectory.some((e) => e.type === "TurnCompleted")
              ? { kind: "complete" as const, output: JSON.stringify(GOOD_ANSWER), mode: REPAIR_TWO }
              : { kind: "complete" as const, output: BAD_ANSWER, mode: REPAIR_TWO }
          )
        }
      }),
      jsSandbox,
      noRouter
    )
    const agent = repairAgent()
    await run(
      Effect.gen(function* () {
        yield* receive(agent, { id: "m1", text: "decompose this topic", output: SCOUT })
        yield* receive(agent, { id: "m2", text: "and again", output: SCOUT })
        return yield* readLog
      }),
      layers
    )
    // The correction round reads the rejected reply and the reasons for it.
    const correcting = rendered[1]!
    expect(correcting.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(correcting[1]!.content).toBe(BAD_ANSWER)
    expect(String(correcting[2]!.content)).toContain("aspects")
    // The next turn reads the corrected value as the result the model gave, with the exchange
    // compacted away.
    const later = rendered[2]!
    expect(later.map((m) => m.content)).toEqual(["decompose this topic", JSON.stringify(GOOD_ANSWER), "and again"])
  })

  test("the corrected attempt asks under a fresh idempotency key", async () => {
    const keys: Array<string | undefined> = []
    const layers = Layer.mergeAll(
      memoryLog(),
      KeyValueStore.layerMemory,
      Layer.succeed(Infer, {
        react: ({ trajectory }: { trajectory: ReadonlyArray<Event> }, key?: string) => {
          keys.push(key)
          return Effect.succeed(
            trajectory.some((e) => e.type === "OutputRejected")
              ? { kind: "complete" as const, output: JSON.stringify(GOOD_ANSWER), mode: REPAIR_TWO }
              : { kind: "complete" as const, output: BAD_ANSWER, mode: REPAIR_TWO }
          )
        }
      }),
      jsSandbox,
      noRouter
    )
    await run(
      Effect.gen(function* () {
        yield* receive(repairAgent(), { id: "m1", text: "decompose this topic", output: SCOUT })
        return yield* readLog
      }),
      layers
    )
    expect(keys).toEqual(["m1/infer/0", "m1/infer/1"])
  })

  test("a model that never satisfies the contract fails the turn instead of looping", async () => {
    let asked = 0
    const layers = Layer.mergeAll(
      memoryLog(),
      KeyValueStore.layerMemory,
      Layer.succeed(Infer, {
        react: () => {
          asked += 1
          return Effect.succeed({ kind: "complete" as const, output: BAD_ANSWER, mode: REPAIR_TWO })
        }
      }),
      jsSandbox,
      noRouter
    )
    const events = await run(
      Effect.gen(function* () {
        yield* receive(repairAgent(), { id: "m1", text: "decompose this topic", output: SCOUT })
        return yield* readLog
      }),
      layers
    )
    const failed = events.find((e) => e.type === "TurnFailed") as { error?: string; cause?: string; policy?: { attempts?: number } }
    expect(failed.cause).toBe("output_repairs_exhausted")
    expect(failed.error).toContain("after 2 corrections")
    expect(failed.policy?.attempts).toBe(2)
    // Bounded by the mounted policy: the corrections are spent, not repeated forever.
    expect(asked).toBe(3)
    expect(events.filter((e) => e.type === "OutputRejected")).toHaveLength(3)
  })

  test("the correction bound is the mounted policy's, and a tighter one spends less", async () => {
    let asked = 0
    const layers = Layer.mergeAll(
      memoryLog(),
      KeyValueStore.layerMemory,
      Layer.succeed(Infer, {
        react: () => {
          asked += 1
          return Effect.succeed({ kind: "complete" as const, output: BAD_ANSWER, mode: repairFallback({ attempts: 0 }) })
        }
      }),
      jsSandbox,
      noRouter
    )
    const events = await run(
      Effect.gen(function* () {
        yield* receive(repairAgent({ attempts: 0 }), { id: "m1", text: "decompose this topic", output: SCOUT })
        return yield* readLog
      }),
      layers
    )
    expect(asked).toBe(1)
    expect(events.find((e) => e.type === "TurnFailed")).toMatchObject({ cause: "output_repairs_exhausted" })
  })

  test("a bound that is not a whole count of asks is refused where it is stated", () => {
    for (const attempts of [-1, 1.5, Number.NaN]) {
      expect(() => outputRepairFor({ attempts })).toThrow("not applicable")
    }
    expect(() => outputRepairFor({ projectHistory: "yes" as never })).toThrow("projectHistory must be true or false")
  })

  test("the recorded policy decides exhaustion, so a later mount cannot extend an old round", () => {
    // Two rejections already stand, recorded under a bound of one. Mounting a looser policy now
    // must not reopen that round: replay reads the log, never today's assembly
    // (src/output.ts, modeOf; runtime/infer.ts, openRejection).
    const spent = repairFallback({ attempts: 1 })
    const seeded: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m1", text: "decompose this topic", output: { name: SCOUT.name, schema: SCOUT.schema }, at: 0 },
      { type: "ModelCalled", callId: "m1/infer/0", ordinal: 0, turn: "m1", at: 1 },
      { type: "OutputRejected", contract: "scout", attempt: "m1/infer/0", text: BAD_ANSWER, errors: ["/aspects: bad"], mode: spent, turn: "m1", at: 2 },
      { type: "ModelCalled", callId: "m1/infer/1", ordinal: 1, turn: "m1", at: 3 },
      { type: "OutputRejected", contract: "scout", attempt: "m1/infer/1", text: BAD_ANSWER, errors: ["/aspects: bad"], mode: spent, turn: "m1", at: 4 }
    ]
    let asked = 0
    const layers = Layer.mergeAll(
      memoryLog(seeded),
      KeyValueStore.layerMemory,
      Layer.succeed(Infer, {
        react: () => {
          asked += 1
          return Effect.succeed({ kind: "complete" as const, output: JSON.stringify(GOOD_ANSWER), mode: REPAIR_TWO })
        }
      }),
      jsSandbox,
      noRouter
    )
    return run(
      Effect.gen(function* () {
        yield* settleActor(repairAgent({ attempts: 5 }))
        return yield* readLog
      }),
      layers
    ).then((events) => {
      expect(asked).toBe(0)
      const failed = events.find((e) => e.type === "TurnFailed") as { cause?: string; policy?: { attempts?: number } }
      expect(failed.cause).toBe("output_repairs_exhausted")
      expect(failed.policy?.attempts).toBe(1)
    })
  })

  test("a malformed latest policy never borrows an older rejection's mode", () => {
    const seeded: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m1", text: "decompose this topic", output: { name: SCOUT.name, schema: SCOUT.schema }, at: 0 },
      { type: "ModelCalled", callId: "m1/infer/0", ordinal: 0, turn: "m1", at: 1 },
      {
        type: "OutputRejected",
        contract: "scout",
        attempt: "m1/infer/0",
        text: BAD_ANSWER,
        errors: ["/aspects: bad"],
        mode: repairFallback({ attempts: 5 }),
        turn: "m1",
        at: 2
      },
      { type: "ModelCalled", callId: "m1/infer/1", ordinal: 1, turn: "m1", at: 3 },
      {
        type: "OutputRejected",
        contract: "scout",
        attempt: "m1/infer/1",
        text: BAD_ANSWER,
        errors: ["/aspects: bad"],
        mode: { kind: "repair", name: "repair", attempts: 5 },
        turn: "m1",
        at: 4
      }
    ]
    let asked = 0
    const layers = Layer.mergeAll(
      memoryLog(seeded),
      KeyValueStore.layerMemory,
      Layer.succeed(Infer, {
        react: () => {
          asked += 1
          return Effect.succeed({ kind: "complete" as const, output: JSON.stringify(GOOD_ANSWER), mode: REPAIR_TWO })
        }
      }),
      jsSandbox,
      noRouter
    )
    return run(
      Effect.gen(function* () {
        yield* settleActor(repairAgent({ attempts: 5 }))
        return yield* readLog
      }),
      layers
    ).then((events) => {
      expect(asked).toBe(0)
      expect(events.find((event) => event.type === "TurnFailed")).toMatchObject({
        cause: "output_validation_failed",
        policy: null
      })
    })
  })

  test("two components declaring an output strategy collide at construction", () => {
    expect(() => actor(infer([codeMode(), outputRepair, outputValidateOnce], TEST_MODEL))).toThrow(
      "output strategy declared by components output.repair and output.validate-once"
    )
  })

  test("a malformed custom fallback is refused at construction", () => {
    const malformed: AgentComponent = {
      name: "output.malformed",
      derive: () => ({
        view: {
          system: [],
          tools: [],
          context: [],
          output: [
            {
              component: "output.malformed",
              kind: "fallback",
              fallback: { kind: "delegated", name: "", projectHistory: true } as never
            }
          ]
        },
        transitions: []
      })
    }
    expect(() => actor(infer([malformed], TEST_MODEL))).toThrow("output fallback declared by component output.malformed")
  })
})

describe("the mind on a native surface", () => {
  test("a turn completes with no budget, code, or compaction reactors", async () => {
    const reads: string[] = []
    const mind = actor(infer([
      toolList([
        {
          spec: { name: "read", description: "read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
          run: (input: unknown) => {
            const path = String((input as { path?: unknown }).path)
            reads.push(path)
            return Effect.succeed(`contents of ${path}`)
          }
        }
      ]),
      reply,
      nativeOutput
    ], TEST_MODEL))
    expect(mind.reactors).toHaveLength(1)
    const layers = Layer.mergeAll(
      memoryLog(),
      noRouter,
      KeyValueStore.layerMemory,
      Layer.succeed(Infer, {
        react: ({ trajectory }: { trajectory: ReadonlyArray<Event> }) => {
          const returned = trajectory.find((e) => e.type === "ToolReturned") as { result?: unknown } | undefined
          return Effect.succeed(
            returned !== undefined
              ? { kind: "complete" as const, output: String(returned.result) }
              : { kind: "call" as const, callId: "n1", name: "read", arguments: { path: "/contract.md" } }
          )
        }
      })
    )
    const events = await run(
      Effect.gen(function* () {
        yield* receive(mind, { id: "m1", text: "read the contract" })
        return yield* readLog
      }),
      layers
    )
    expect(events.map((e) => e.type)).toEqual([
      "MessageReceived",
      "ModelResolved",
      "ModelCalled",
      "ToolCalled",
      "ToolReturned",
      "ModelCalled",
      "TurnCompleted",
      "ReplyDelivered"
    ])
    expect(reads).toEqual(["/contract.md"])
    expect(events.some((e) => e.type === "CodeDispatched" || e.type === "BudgetExhausted" || e.type === "ContextCompacted")).toBe(false)
  })
})

describe("the validate-once implementation", () => {
  const validateOnceAgent = actor(infer([codeMode(), reply, budget, compaction(), outputValidateOnce], TEST_MODEL))

  test("a missed response ends the turn with its own cause, and never asks again", async () => {
    let asked = 0
    const layers = Layer.mergeAll(
      memoryLog(),
      KeyValueStore.layerMemory,
      Layer.succeed(Infer, {
        react: (request: InferRequest) => {
          asked += 1
          // The fallback carries its own instruction, and the base prompt stays what it would be
          // with nothing mounted (request.ts, OutputRequest).
          expect(request.output?.system).toContain('conforming to the schema "scout"')
          expect(request.system).not.toContain("scout")
          return Effect.succeed({ kind: "complete" as const, output: BAD_ANSWER, mode: VALIDATE_ONCE_FALLBACK })
        }
      }),
      jsSandbox,
      noRouter
    )
    const events = await run(
      Effect.gen(function* () {
        yield* receive(validateOnceAgent, { id: "m1", text: "decompose this topic", output: SCOUT })
        return yield* readLog
      }),
      layers
    )
    expect(asked).toBe(1)
    expect(events.some((e) => e.type === "OutputRejected")).toBe(false)
    const failed = events.find((e) => e.type === "TurnFailed") as { cause?: string; error?: string }
    // Its own class: a local decision to stop, told apart from a provider breaking a promise it
    // made and from a correction loop spending its bound (src/events.ts, TURN_FAILURE_CAUSES).
    expect(failed.cause).toBe("output_validation_failed")
    expect(failed.error).toContain("aspects")
  })

  test("a conforming response completes the turn like any other", async () => {
    const layers = Layer.mergeAll(
      memoryLog(),
      KeyValueStore.layerMemory,
      Layer.succeed(Infer, { react: () => Effect.succeed({ kind: "complete" as const, output: JSON.stringify(GOOD_ANSWER), mode: VALIDATE_ONCE_FALLBACK }) }),
      jsSandbox,
      noRouter
    )
    const events = await run(
      Effect.gen(function* () {
        yield* receive(validateOnceAgent, { id: "m1", text: "decompose this topic", output: SCOUT })
        return yield* readLog
      }),
      layers
    )
    expect(outputOf(SCOUT, events, "m1")).toEqual(GOOD_ANSWER)
  })
})

// A domain-specific mechanism is a component with its own implementation value. The core records
// the rejection and stops; this component decides the feedback, the bound, and whether to ask
// again at all. Nothing about the framework repair loop reaches it.
const HOUSE_STYLE: OutputFallback = { kind: "delegated", name: "house-style", projectHistory: true }

const houseStyle = (options: { readonly asks: number }): AgentComponent => ({
  name: "output.house-style",
  derive: (log: ReadonlyArray<Event>) => {
    const rejections = log.filter((e) => e.type === "OutputRejected")
    const answered = new Set(
      log.filter((e) => e.type === "OutputRetryRequested").map((e) => String((e as { rejection?: unknown }).rejection))
    )
    const owed = rejections.find((e) => !answered.has(String((e as { attempt?: unknown }).attempt))) as
      | { attempt?: string; turn?: string }
      | undefined
    const view = {
      system: [],
      tools: [],
      context: [],
      output: [{ component: "output.house-style", kind: "fallback" as const, fallback: HOUSE_STYLE }]
    }
    if (owed === undefined) return { view, transitions: [] }
    const spent = rejections.length
    if (spent > options.asks) {
      return {
        view,
        transitions: [
          transition({
            key: `tn:${String(owed.turn)}`,
            input: { turn: String(owed.turn) },
            act: (input) =>
              Effect.gen(function* () {
                const at = yield* Clock.currentTimeMillis
                return [turnFailed({ error: "the house style was not met", cause: "output_validation_failed", turn: input.turn, at })]
              })
          })
        ]
      }
    }
    return {
      view,
      transitions: [
        transition({
          key: `oq:${String(owed.attempt)}`,
          input: { rejection: String(owed.attempt), turn: String(owed.turn) },
          act: (input) =>
            Effect.gen(function* () {
              const at = yield* Clock.currentTimeMillis
              return [
                outputRetryRequested({
                  rejection: input.rejection,
                  feedback: "House style: every description ends in a full stop.",
                  by: "output.house-style",
                  decision: { rule: "full-stop" },
                  turn: input.turn,
                  at
                })
              ]
            })
        })
      ]
    }
  }
})

describe("a domain-specific implementation", () => {
  test("the core records the rejection and waits; the component decides the feedback", async () => {
    const prompts: Array<ReadonlyArray<{ readonly role: string; readonly content: string | null }>> = []
    const layers = Layer.mergeAll(
      memoryLog(),
      KeyValueStore.layerMemory,
      Layer.succeed(Infer, {
        react: (request: InferRequest) => {
          prompts.push(modelRequest(request.trajectory, request, request.context ?? {}).messages)
          return Effect.succeed(
            request.trajectory.some((e) => e.type === "OutputRetryRequested")
              ? { kind: "complete" as const, output: JSON.stringify(GOOD_ANSWER), mode: HOUSE_STYLE }
              : { kind: "complete" as const, output: BAD_ANSWER, mode: HOUSE_STYLE }
          )
        }
      }),
      jsSandbox,
      noRouter
    )
    const agent = actor(infer([codeMode(), reply, houseStyle({ asks: 2 })], TEST_MODEL))
    const events = await run(
      Effect.gen(function* () {
        yield* receive(agent, { id: "m1", text: "decompose this topic", output: SCOUT })
        return yield* readLog
      }),
      layers
    )
    // The component's own request stands between the rejection and the next ask.
    expect(events.map((e) => e.type)).toContain("OutputRetryRequested")
    const decided = events.find((e) => e.type === "OutputRetryRequested") as { feedback?: string; by?: string; decision?: unknown }
    expect(decided.by).toBe("output.house-style")
    expect(decided.decision).toEqual({ rule: "full-stop" })
    // The second prompt carries the component's sentence, and none of the framework's.
    const correcting = prompts[1]!.map((m) => String(m.content)).join("\n")
    expect(correcting).toContain("House style: every description ends in a full stop.")
    expect(correcting).not.toContain("Reply again with JSON")
    expect(correcting).not.toContain("never a string holding one")
    expect(outputOf(SCOUT, events, "m1")).toEqual(GOOD_ANSWER)
  })

  test("without its decision the turn rests: the core schedules no ask of its own", async () => {
    let asked = 0
    const layers = Layer.mergeAll(
      memoryLog(),
      KeyValueStore.layerMemory,
      Layer.succeed(Infer, {
        react: () => {
          asked += 1
          return Effect.succeed({ kind: "complete" as const, output: BAD_ANSWER, mode: HOUSE_STYLE })
        }
      }),
      jsSandbox,
      noRouter
    )
    // A component that mounts the implementation and derives nothing: the rejection stands, and
    // the turn is durably parked rather than quietly retried.
    const silent: AgentComponent = {
      name: "output.silent",
      derive: () => ({
        view: { system: [], tools: [], context: [], output: [{ component: "output.silent", kind: "fallback", fallback: HOUSE_STYLE }] },
        transitions: []
      })
    }
    const events = await run(
      Effect.gen(function* () {
        yield* receive(actor(infer([codeMode(), silent], TEST_MODEL)), {
          id: "m1",
          text: "decompose this topic",
          output: SCOUT
        })
        return yield* readLog
      }),
      layers
    )
    expect(asked).toBe(1)
    expect(events.filter((e) => e.type === "OutputRejected")).toHaveLength(1)
    expect(events.some((e) => e.type === "TurnCompleted" || e.type === "TurnFailed")).toBe(false)
  })

  test("its own bound ends the turn its own way", async () => {
    const layers = Layer.mergeAll(
      memoryLog(),
      KeyValueStore.layerMemory,
      Layer.succeed(Infer, { react: () => Effect.succeed({ kind: "complete" as const, output: BAD_ANSWER, mode: HOUSE_STYLE }) }),
      jsSandbox,
      noRouter
    )
    const agent = actor(infer([codeMode(), reply, houseStyle({ asks: 1 })], TEST_MODEL))
    const events = await run(
      Effect.gen(function* () {
        yield* receive(agent, { id: "m1", text: "decompose this topic", output: SCOUT })
        return yield* readLog
      }),
      layers
    )
    const failed = events.find((e) => e.type === "TurnFailed") as { error?: string; cause?: string }
    expect(failed.error).toBe("the house style was not met")
    expect(failed.cause).toBe("output_validation_failed")
    expect(events.filter((e) => e.type === "OutputRejected")).toHaveLength(2)
  })
})

describe("a declaration nobody can serve", () => {
  test("ends the turn before a model is asked", async () => {
    let asked = 0
    const layers = Layer.mergeAll(
      memoryLog(),
      KeyValueStore.layerMemory,
      Layer.succeed(Infer, {
        react: () => {
          asked += 1
          return Effect.succeed({ kind: "complete" as const, output: "{}" })
        }
      }),
      jsSandbox,
      noRouter
    )
    const events = await run(
      Effect.gen(function* () {
        const log = yield* EventLog
        const at = yield* Clock.currentTimeMillis
        // A brief that arrived through a door with no TypeScript on it: the API declares a
        // contract, and this declares an open schema no wire sends unchanged.
        yield* send(rlmAgent, {
          type: "MessageReceived",
          id: "m1",
          text: "go",
          output: { name: "loose", schema: { type: "object", properties: { a: { type: "string" } }, required: [] } },
          at
        })
        void log
        return yield* readLog
      }),
      layers
    )
    expect(asked).toBe(0)
    const failed = events.find((e) => e.type === "TurnFailed") as { cause?: string; error?: string }
    expect(failed.cause).toBe("output_unsupported")
    expect(failed.error).toContain("required must list every property")
  })
})
