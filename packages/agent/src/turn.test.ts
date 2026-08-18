import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import type { Event } from "@tardigrade/core/event"
import { EventLog, withWatermark } from "@tardigrade/core/event-log"
import { settleActor } from "@tardigrade/core/actor"
import { Packages, type Package } from "@tardigrade/code/packages"
import { Sandbox, type Bindings } from "@tardigrade/code/sandbox"
import { Router } from "@tardigrade/core/router"
import { Self } from "@tardigrade/core/actor"
import { Infer, agentFor, rlmAgent, receive } from "./turn"
import { inferReactor } from "./infer"
import { toolsReactor } from "./tools"
import { nativeSurface } from "./surface"
import { Tmp } from "@tardigrade/code/tmp"
const memSpill = () => {
  const store = new Map<string, string>()
  return Layer.succeed(Tmp, {
    store: (ref: string, json: string) => Effect.sync(() => void store.set(ref, json)),
    load: (ref: string) => Effect.sync(() => store.get(ref))
  })
}

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
        const names = Object.keys(bindings)
        const body = new AsyncFunction(...names, code)
        return { result: await body(...names.map((name) => bindings[name])) }
      } catch (e) {
        return { error: String(e) }
      }
    })
})

const registry = (packages: ReadonlyArray<Package>) =>
  Layer.succeed(Packages, {
    resolve: (name: string) => packages.find((p) => p.name === name),
    list: () => Effect.succeed(packages.map((p) => ({ name: p.name, description: p.description })))
  })

const zoho = (spies: { insert: number; search: number }): Package => ({
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

// No other actors exist in these tests: delivery is a no-op and a sync call answers with an error.
const noRouter = Layer.mergeAll(
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
    const layers = Layer.mergeAll(
    memSpill(),
    memoryLog(), codeThenComplete(count), registry([zoho(spies)]), jsSandbox, noRouter)
    const events = await run(
      Effect.gen(function* () {
        yield* receive(rlmAgent, { id: "m1", text: "add the JD and search candidates" })
        return yield* readLog
      }),
      layers
    )
    expect(events.map((e) => e.type)).toEqual([
      "MessageReceived",
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
    expect(events[4]).toMatchObject({ callId: "t1.0", name: "zohorecruit.insert_record" })
    expect(events[8]).toMatchObject({ result: { jd_record_id: "jd-91", hits: 3 } })
    expect(spies).toEqual({ insert: 1, search: 1 })
    expect(count.calls).toBe(2)
    expect(inferReactor(events)).toHaveLength(0)
    expect(toolsReactor(events)).toHaveLength(0)
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
    const [answer] = toolsReactor(events)
    expect(answer).toBeDefined()
    const returned = await run(answer!.act(answer!.input as never) as Effect.Effect<ReadonlyArray<Event>>, memoryLog())
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
    const layers = Layer.mergeAll(memSpill(), memoryLog(crashed), codeThenComplete(count), registry([zoho(spies)]), jsSandbox, noRouter)
    const events = await run(
      Effect.gen(function* () {
        yield* settleActor(rlmAgent)
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
    memSpill(),
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
      registry([]),
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
    memSpill(),
    memoryLog(queued), echoHead, registry([]), jsSandbox, noRouter)
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
    const layers = Layer.mergeAll(memSpill(), memoryLog(crashed), codeThenComplete(count), registry([]), jsSandbox, noRouter)
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
    memSpill(),
    memoryLog(),
      Layer.succeed(Infer, {
        react: () => {
          count.calls += 1
          return Effect.succeed({ kind: "complete" as const, output: "ok" })
        }
      }),
      registry([]),
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
      memSpill(),
      memoryLog(),
      Layer.succeed(Infer, {
        react: () => Effect.succeed({ kind: "complete" as const, output: "ok", usage: spent })
      }),
      registry([]),
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
      "ModelCalled",
      "TurnCompleted",
      "ReplyDelivered"
    ])
    expect(events.find((e) => e.type === "TurnCompleted")).toMatchObject({
      turn: "m1",
      usage: spent
    })
  })
})

// The scout schema from a research task, and the two answers a model gives: the double-encoded
// one that broke a prod run, then the correct one after it reads its own errors.
const SCOUT_SCHEMA = {
  type: "object",
  properties: {
    aspects: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, description: { type: "string" } },
        required: ["name", "description"]
      }
    }
  },
  required: ["aspects"]
}
const GOOD_ANSWER = { aspects: [{ name: "grader nondeterminism", description: "how graders drift" }] }

describe("a turn that declares an output schema", () => {
  test("an off-schema answer is refused, and the model's correction terminates the turn", async () => {
    const seen: Array<string> = []
    const layers = Layer.mergeAll(
      memoryLog(),
      memSpill(),
      Layer.succeed(Infer, {
        react: ({ trajectory }: { trajectory: ReadonlyArray<Event> }) => {
          // The repair is a real tool return, so the model reads why it was refused.
          const refusal = trajectory.find(
            (e) => e.type === "ToolReturned" && String(((e as { result?: { error?: unknown } }).result ?? {}).error ?? "").includes("output schema")
          )
          seen.push(refusal === undefined ? "first" : "corrected")
          return Effect.succeed(
            refusal === undefined
              // The whole answer, stringified, inside the field that should hold the array.
              ? { kind: "call" as const, callId: "a1", name: "answer", arguments: { aspects: JSON.stringify(GOOD_ANSWER) } }
              : { kind: "complete" as const, output: JSON.stringify(GOOD_ANSWER) }
          )
        }
      }),
      registry([]),
      jsSandbox,
      noRouter
    )
    const events = await run(
      Effect.gen(function* () {
        yield* receive(rlmAgent, { id: "m1", text: "decompose this topic", output: SCOUT_SCHEMA })
        return yield* readLog
      }),
      layers
    )
    // The model was asked twice: once for the bad answer, once after reading the reasons.
    expect(seen).toEqual(["first", "corrected"])
    const returned = events.find((e) => e.type === "ToolReturned") as { result?: { error?: string } }
    expect(returned.result?.error).toContain("did not match this turn's output schema")
    expect(returned.result?.error).toContain("aspects")
    const terminal = events.find((e) => e.type === "TurnCompleted") as { output?: string }
    expect(JSON.parse(String(terminal.output))).toEqual(GOOD_ANSWER)
    expect(events.some((e) => e.type === "TurnFailed")).toBe(false)
  })

  test("a model that never satisfies the schema fails the turn instead of looping", async () => {
    let asked = 0
    const layers = Layer.mergeAll(
      memoryLog(),
      memSpill(),
      Layer.succeed(Infer, {
        react: () => {
          asked += 1
          return Effect.succeed({
            kind: "call" as const,
            callId: `a${asked}`,
            name: "answer",
            arguments: { aspects: "still a string" }
          })
        }
      }),
      registry([]),
      jsSandbox,
      noRouter
    )
    const events = await run(
      Effect.gen(function* () {
        yield* receive(rlmAgent, { id: "m1", text: "decompose this topic", output: SCOUT_SCHEMA })
        return yield* readLog
      }),
      layers
    )
    const failed = events.find((e) => e.type === "TurnFailed") as { error?: string }
    expect(failed.error).toContain("did not satisfy the declared schema")
    // Bounded: the corrections are spent, not repeated forever.
    expect(asked).toBeLessThanOrEqual(4)
  })
})

describe("the mind on a native surface", () => {
  test("a turn completes with no budget, code, or compaction reactors", async () => {
    const reads: string[] = []
    const mind = agentFor(
      nativeSurface([
        {
          spec: { name: "read", description: "read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
          run: (input) => {
            const path = String((input as { path?: unknown }).path)
            reads.push(path)
            return Effect.succeed(`contents of ${path}`)
          }
        }
      ])
    )
    expect(mind.reactors).toHaveLength(3)
    const layers = Layer.mergeAll(
      memoryLog(),
      noRouter,
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
