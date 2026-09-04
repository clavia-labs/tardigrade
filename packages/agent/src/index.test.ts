import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import type { Event } from "@clavia/tardigrade-core/log/event"
import {
  CANCELLATION_CONTROL_METHOD,
  cancellationMethodFor,
  type Actor
} from "@clavia/tardigrade-core/actor"
import { jsSandboxFor } from "@clavia/tardigrade-code/sandbox/defaults"
import { workspacePackage } from "@clavia/tardigrade-code/package/workspace"
import { createHost, type Host, type ThreadEnv } from "@clavia/tardigrade-host/host"
import type { Action } from "./log/events"
import { Infer, NativeOutputSupport, type InferRequest } from "./inference/contract"
import { boundaryOf } from "./output/boundary"
import { resumeTurn } from "./runtime/resume"
import { agentsPackage } from "./packages/agents"
import { threadCreated, threadCreatedOf } from "@clavia/tardigrade-core/thread"
import { linkOf } from "@clavia/tardigrade-core/communication/link"
import { methodEnvelopeOf } from "@clavia/tardigrade-core/communication/envelope"
import { threadAddressOf } from "@clavia/tardigrade-core/communication/endpoint"
import { actor, agentMethods, budget, codeMode, compaction, infer, nativeOutput, tool, type AgentComponent } from "./index"
import type { AgentR } from "./runtime/turn"

const ROOT_THREAD = "ag.root"
const TEST_MODEL = { models: { default: { provider: "test", model_id: "test-model" }, allow: "*" } } as const

// The headline: one ask, an emergent graph, one answer, library only.
// The root's code spawns two children; the host births their threads,
// routes briefs and replies, parks and wakes the root, and ask returns
// when the root settles. No app imports anywhere.

type Mind = (request: InferRequest, key?: string) => Promise<Action>

type Settled = { readonly turn: string; readonly output?: string; readonly error?: string }

type TestR = AgentR | NativeOutputSupport

// work is the default work surface these tests assemble against: code mode with the spawn and
// workspace packages in scope. The packages are values, so the same list mounts on any host.
const work = () => codeMode([agentsPackage({ budget: {} }), workspacePackage({ policy: {} })])

// hosted binds one assembled actor to an in-process host and drives the root thread. It is the
// test's own driver: commit a root brief, drive to quiescence, read the boundary the settle left.
// A caller with its own host does the same three things (host.ts, Host).
const hosted = (assembled: Actor<TestR>, mind: Mind, log: ReadonlyArray<Event> = []) => {
  const layersFor = (_thread: string): ThreadEnv<TestR> =>
    Layer.mergeAll(
      KeyValueStore.layerMemory,
      jsSandboxFor({}),
      Layer.succeed(Infer, { react: (request: InferRequest, key?: string) => Effect.promise(() => mind(request, key)) }),
      Layer.succeed(NativeOutputSupport, { withTools: true })
    )
  const host: Host = createHost<TestR>({
    actorName: "mem",
    actorFor: (thread: string) => (thread.startsWith("ag.") ? assembled : undefined),
    layersFor
  })
  if (log.length > 0) host.seed(ROOT_THREAD, log)

  // Run ids continue past a seeded history, so a resumed agent's new run never wears an id the
  // log already dedups.
  let n = log.length
  const settled = (turn: string): Settled => {
    const boundary = boundaryOf(host.read(ROOT_THREAD), turn)
    if (boundary === undefined) return { turn, error: "the root never settled" }
    if (boundary.kind === "completed") return { turn, output: boundary.output }
    if (boundary.kind === "failed") return { turn, error: boundary.error }
    return { turn, error: "the root parked on a budget ask with nobody to answer" }
  }
  const run = async (brief: string): Promise<Settled> => {
    const id = `run-${n++}`
    host.commitRoot(host.self(ROOT_THREAD), { type: "MessageReceived", id, text: brief, at: n } as Event)
    await host.drive()
    return settled(id)
  }
  const resume = async (turn: string): Promise<Settled> => {
    await resumeTurn(host, ROOT_THREAD, turn)
    return settled(turn)
  }
  return { run, resume, host }
}

// rlm is the default assembly: the work surface, budget, and compaction, over an
// in-process host. The three policy components are always mounted, so a test that swaps the
// work surface still runs the same turn loop, budget wall, and answer contract.
const rlm = (mind: Mind, components: ReadonlyArray<AgentComponent<AgentR>> = [work()], log: ReadonlyArray<Event> = []) =>
  hosted(actor({
    name: "test-agent",
    methods: agentMethods,
    components: [infer([budget(components), compaction(), nativeOutput], TEST_MODEL)]
  }), mind, log)

const headText = (trajectory: ReadonlyArray<Event>): string => {
  for (let i = trajectory.length - 1; i >= 0; i--) {
    const e = trajectory[i]!
    if (e.type === "MessageReceived") return String((e as { text?: unknown }).text ?? "")
  }
  return ""
}

// The scripted mind honors the Infer seam's contract: fresh tool call
// ids per call (real providers mint tooluse ids), and it reads only the
// CURRENT turn's slice, so a second turn genuinely re-runs.
const scripted = async ({ trajectory }: { trajectory: ReadonlyArray<Event> }): Promise<Action> => {
  const brief = headText(trajectory)
  if (brief.startsWith("sum ")) {
    const [a, b] = brief.slice(4).split("+").map(Number)
    return { kind: "complete", output: String(a! + b!) }
  }
  const turnStart = trajectory.reduce((n, e, i) => (e.type === "MessageReceived" ? i : n), 0)
  const turn = trajectory.slice(turnStart)
  const returned = turn.find((e) => e.type === "ToolReturned") as { result?: { result?: unknown } } | undefined
  if (returned !== undefined) {
    return { kind: "complete", output: JSON.stringify(returned.result?.result ?? null) }
  }
  const turns = trajectory.filter((e) => e.type === "MessageReceived").length
  return {
    kind: "call",
    callId: `t${turns}`,
    name: "execute",
    arguments: {
      code: `const [a, b] = await Promise.all([
        agents.run({ text: "sum 2+2" }),
        agents.run({ text: "sum 3+3" })
      ]); return a.output + "," + b.output;`
    }
  }
}

describe("an assembled agent", () => {
  test("a running inference cancels without appending its late answer", async () => {
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const mind = rlm(async () => {
      markStarted()
      await held
      return { kind: "complete", output: "late" }
    })
    mind.host.commitRoot(mind.host.self(ROOT_THREAD), {
      type: "MessageReceived",
      id: "m1",
      text: "wait",
      at: 1
    } as Event)
    const driving = mind.host.drive()
    await started
    mind.host.commitRoot(mind.host.self(ROOT_THREAD), {
      type: "CancellationRequested",
      request: "x1",
      invocation: { method: "message", id: "m1", epoch: 0 },
      cause: "requested",
      reason: "operator stopped it",
      at: 2
    } as Event)
    await driving
    release()

    const log = mind.host.read(ROOT_THREAD)
    expect(log.filter((event) => event.type === "TurnCancelled")).toEqual([
      expect.objectContaining({ request: "x1", turn: "m1", reason: "operator stopped it" })
    ])
    expect(log.some((event) => event.type === "TurnCompleted")).toBe(false)
  })

  test("distinct cancel calls absorb into one terminal and both receive a response", async () => {
    const mind = rlm(async () => {
      throw new Error("a queued cancelled invocation must not infer")
    })
    const target = threadAddressOf("mem", "main", ROOT_THREAD)
    mind.host.commitRoot(mind.host.self(ROOT_THREAD), {
      type: "MessageReceived",
      id: "m1",
      text: "wait",
      at: 1
    } as Event)
    const cancellationMethod = cancellationMethodFor(agentMethods)
    for (const [index, id] of ["x1", "x2"].entries()) {
      const source = threadAddressOf("mem", "main", `caller-${index + 1}`)
      mind.host.seed(source.thread, [threadCreated(source, undefined, 1)])
      mind.host.commit(methodEnvelopeOf(
        linkOf(source, target),
        { invocation: { method: CANCELLATION_CONTROL_METHOD, id, epoch: 0 } },
        cancellationMethod.event({
          invocation: { method: CANCELLATION_CONTROL_METHOD, id, epoch: 0 },
          input: { invocation: { method: "message", id: "m1", epoch: 0 } },
          at: index + 2
        })
      ))
    }
    await mind.host.drive()

    const root = mind.host.read(ROOT_THREAD)
    expect(root.filter((event) => event.type === "CancellationRequested")).toHaveLength(2)
    expect(root.filter((event) => event.type === "TurnCancelled")).toHaveLength(1)
    expect(root.filter((event) => event.type === "ResponseDelivered" &&
      String((event as { readonly method?: unknown }).method) === CANCELLATION_CONTROL_METHOD)).toHaveLength(2)
    for (const [index, id] of ["x1", "x2"].entries()) {
      expect(mind.host.read(`caller-${index + 1}`).filter((event) => event.type === "ResponseReceived")).toEqual([
        expect.objectContaining({ method: CANCELLATION_CONTROL_METHOD, call: id, status: "completed", output: { cancelled: true } })
      ])
    }
  })

  test("one complete RLM run records root and child lineage and settles with their answers", async () => {
    const mind = rlm(scripted)
    const answer = await mind.run("fan out and add")
    expect(answer.error).toBeUndefined()
    expect(answer.output).toBe('"4,6"')
    expect(threadCreatedOf(mind.host.read(ROOT_THREAD))).toEqual({
      type: "ThreadCreated",
      address: { actor: "mem", instance: "main", thread: ROOT_THREAD },
      depth: 0,
      at: 1
    })
    expect(mind.host.read(ROOT_THREAD).filter((event) => event.type === "ChildCreated")).toEqual([
      expect.objectContaining({ callId: "t1.0", turn: "run-0", address: { actor: "mem", instance: "main", thread: "ag.5:run-0t1.0" }, depth: 1 }),
      expect.objectContaining({ callId: "t1.1", turn: "run-0", address: { actor: "mem", instance: "main", thread: "ag.5:run-0t1.1" }, depth: 1 })
    ])
    // The graph existed: two child threads, each with a served turn.
    const children = ["ag.5:run-0t1.0", "ag.5:run-0t1.1"].map((thread) => mind.host.read(thread))
    for (const log of children) {
      expect(threadCreatedOf(log)).toMatchObject({
        address: { actor: "mem" },
        parent: { actor: "mem", instance: "main", thread: ROOT_THREAD },
        depth: 1
      })
      expect(log.some((e) => e.type === "TurnCompleted")).toBe(true)
      expect(log.some((e) => e.type === "ResponseDelivered")).toBe(true)
    }
    // And it is quiet: nothing owed anywhere.
    expect(mind.host.resting()).toBe(true)
  })

  test("root and child inference requests carry their actor identity", async () => {
    const seen: Array<{ readonly request: InferRequest; readonly key?: string }> = []
    const mind = rlm(async (request, key) => {
      seen.push({ request, ...(key === undefined ? {} : { key }) })
      return scripted(request)
    })
    await mind.run("fan out and add")
    expect(seen.some(({ request }) =>
      request.identity.actor === "mem" &&
      request.identity.thread === ROOT_THREAD &&
      request.identity.turn === "run-0"
    )).toBe(true)
    expect(new Set(seen.map(({ request }) => request.identity.thread))).toEqual(new Set([
      ROOT_THREAD,
      "ag.5:run-0t1.0",
      "ag.5:run-0t1.1"
    ]))
    for (const { request, key } of seen) {
      expect(key?.startsWith(`${request.identity.turn}/infer/`)).toBe(true)
    }
  })

  test("an agent initialises from a log: history carries, new runs continue past it", async () => {
    // Run one agent to a settled state, carry its log into a fresh one: the seeded agent reads
    // the same history, and a new run serves without colliding with a recorded id.
    const first = rlm(scripted)
    await first.run("sum 1+2")
    const carried = first.host.read(ROOT_THREAD)

    const resumed = rlm(scripted, [work()], carried)
    expect(resumed.host.read(ROOT_THREAD)).toEqual(carried)
    const again = await resumed.run("sum 3+4")
    expect(again.output).toBe("7")
    // Both turns live on one log: the carried terminal and the new one.
    expect(resumed.host.read(ROOT_THREAD).filter((e) => e.type === "TurnCompleted")).toHaveLength(2)
    expect(resumed.host.resting()).toBe(true)
  })

  test("replay emits no inference", async () => {
    const first = rlm(scripted)
    await first.run("sum 1+2")
    const carried = first.host.read(ROOT_THREAD)
    let calls = 0
    const resumed = rlm(async (request) => {
      calls += 1
      return scripted(request)
    }, [work()], carried)
    await resumed.host.drive()
    expect(calls).toBe(0)
    expect(resumed.host.read(ROOT_THREAD)).toEqual(carried)
  })

  test("a second run reuses the root thread as a genuinely fresh turn", async () => {
    const mind = rlm(scripted)
    await mind.run("fan out and add")
    const again = await mind.run("fan out and add")
    expect(again.output).toBe('"4,6"')
    // The second turn ran its own execution and spawned its own children.
    expect(mind.host.read(ROOT_THREAD).filter((e) => e.type === "CodeSettled")).toHaveLength(2)
    for (const thread of ["ag.5:run-1t2.0", "ag.5:run-1t2.1"]) {
      expect(mind.host.read(thread).some((e) => e.type === "TurnCompleted")).toBe(true)
    }
  })

  test("a native tool surface runs the same turn loop with no code thread", async () => {
    // The benchmark shape: a fixed table of named tools, called directly. Code mode is the
    // default rather than the only surface, so an agent measured against another harness keeps
    // the turn loop, the budget wall, and the answer contract while presenting that harness's
    // tools (surface.ts).
    const reads: string[] = []
    const components = [tool([
      {
        spec: { name: "read", description: "read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
        run: (input) => {
          const path = String((input as { path?: unknown }).path)
          reads.push(path)
          return Effect.succeed(`contents of ${path}`)
        }
      }
    ])]
    const mind = rlm(async ({ trajectory }) => {
      const returned = trajectory.find((e) => e.type === "ToolReturned") as { result?: unknown } | undefined
      if (returned !== undefined) return { kind: "complete", output: String(returned.result) }
      return { kind: "call", callId: "n1", name: "read", arguments: { path: "/contract.md" } }
    }, components)
    const answer = await mind.run("read the contract")
    expect(answer.output).toBe("contents of /contract.md")
    expect(reads).toEqual(["/contract.md"])
    // The tool answered directly: no code was ever dispatched.
    const log = mind.host.read(ROOT_THREAD)
    expect(log.some((e) => e.type === "CodeDispatched")).toBe(false)
    expect(log.filter((e) => e.type === "ToolReturned")).toHaveLength(1)
  })

  test("a failed turn resumes from its last committed inference", async () => {
    const reads: string[] = []
    const keys: string[] = []
    const failureInRequest: boolean[] = []
    let postToolCalls = 0
    const components = [
      tool([
        {
          spec: { name: "read", description: "read a file", inputSchema: { type: "object", properties: {} } },
          run: () => {
            reads.push("contract")
            return Effect.succeed("contents")
          }
        }
      ])
    ]
    const mind = rlm(async ({ trajectory }, key) => {
      keys.push(String(key))
      failureInRequest.push(trajectory.some((event) => event.type === "TurnFailed"))
      const returned = trajectory.find((event) => event.type === "ToolReturned")
      if (returned === undefined) return { kind: "call", callId: "read-1", name: "read", arguments: {} }
      postToolCalls += 1
      if (postToolCalls === 1) throw new Error("provider connection ended")
      return { kind: "complete", output: String((returned as { result?: unknown }).result) }
    }, components)

    const failed = await mind.run("read the contract")
    expect(failed).toMatchObject({ turn: "run-0", error: "provider connection ended" })

    const completed = await mind.resume(failed.turn)
    expect(completed).toEqual({ turn: "run-0", output: "contents" })
    expect(reads).toEqual(["contract"])
    expect(keys).toEqual(["run-0/infer/0", "run-0/infer/1", "run-0/infer/1"])
    expect(failureInRequest).toEqual([false, false, false])

    const log = mind.host.read(ROOT_THREAD)
    expect(log.filter((event) => event.type === "TurnFailed")).toEqual([
      expect.objectContaining({
        turn: "run-0",
        error: "provider connection ended",
        cause: "inference_error",
        attempts: 1,
        attemptKey: "run-0/infer/1"
      })
    ])
    expect(log.filter((event) => event.type === "TurnResumed")).toEqual([
      expect.objectContaining({ turn: "run-0", failedEpoch: 0, epoch: 1 })
    ])
    expect(log.filter((event) => event.type === "TurnCompleted")).toEqual([
      expect.objectContaining({ turn: "run-0", epoch: 1, output: "contents" })
    ])
    expect(log.filter((event) => event.type === "ResponseDelivered")).toHaveLength(0)
  })

  test("only a failed active epoch can resume", async () => {
    const mind = rlm(async () => ({ kind: "complete", output: "done" }))
    const completed = await mind.run("finish")

    await expect(mind.resume(completed.turn)).rejects.toThrow("active epoch is not failed")
    await expect(mind.resume("missing")).rejects.toThrow("active epoch is not failed")
  })

  test("a model-declared failure advances the inference key on resume", async () => {
    const keys: string[] = []
    const mind = rlm(async (_request, key) => {
      keys.push(String(key))
      return keys.length === 1
        ? { kind: "fail", error: "the task is invalid" }
        : { kind: "complete", output: "reconsidered" }
    })

    const failed = await mind.run("try")
    expect(await mind.resume(failed.turn)).toMatchObject({ output: "reconsidered" })
    expect(keys).toEqual(["run-0/infer/0", "run-0/infer/1"])
  })

  test("a call outside the surface comes back as an unknown tool, never a dead turn", async () => {
    const components = [tool([
      { spec: { name: "read", description: "read", inputSchema: {} }, run: () => Effect.succeed("ok") }
    ])]
    const mind = rlm(async ({ trajectory }) => {
      const returned = trajectory.find((e) => e.type === "ToolReturned") as { result?: { error?: string } } | undefined
      if (returned !== undefined) return { kind: "complete", output: String(returned.result?.error) }
      return { kind: "call", callId: "x1", name: "execute", arguments: { code: "return 1" } }
    }, components)
    const answer = await mind.run("go")
    expect(answer.output).toContain("unknown tool: execute")
    expect(answer.output).toContain("read")
  })

  test("the workspace reads back what a spilled result put in the store", async () => {
    // The mounted workspace and the code reactor's spill path hold one store: a result too large
    // for the event spills, and the next body finds it by grep and slices it by ref.
    const mind = rlm(async ({ trajectory }) => {
      const start = trajectory.reduce((n, e, i) => (e.type === "MessageReceived" ? i : n), 0)
      const returns = trajectory.slice(start).filter((e) => e.type === "ToolReturned") as ReadonlyArray<{ result?: { result?: unknown } }>
      if (returns.length === 0) {
        return { kind: "call", callId: "w1", name: "execute", arguments: { code: `return "a".repeat(20000) + "NEEDLE";` } }
      }
      if (returns.length === 1) {
        return {
          kind: "call",
          callId: "w2",
          name: "execute",
          arguments: {
            code: `const found = await workspace.grep({ pattern: "NEEDLE" });
                const hit = found.matches[0];
                const back = await workspace.read({ ref: hit.ref, offset: hit.offset, length: 6 });
                return hit.ref + ":" + hit.offset + ":" + back.slice + ":" + back.size;`
          }
        }
      }
      return { kind: "complete", output: String(returns[1]!.result?.result ?? "") }
    })
    // The store holds the result's JSON, so the offset counts the opening quote too.
    const answer = await mind.run("spill then search")
    expect(answer.output).toBe("w1.result:20001:NEEDLE:20008")
  })
})
