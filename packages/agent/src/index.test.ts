import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/event"
import type { Action } from "./events"
import { Effect } from "effect"
import { createRlmAgent } from "./index"
import { toolList } from "./capability"

const ROOT_LANE = "ag.root"

// The headline: one ask, an emergent graph, one answer, library only.
// The root's code spawns two children; the host births their lanes,
// routes briefs and replies, parks and wakes the root, and ask returns
// when the root settles. No app imports anywhere.

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

describe("createRlmAgent", () => {
  test("one run fans out to two children and settles with their answers", async () => {
    const mind = createRlmAgent({ infer: scripted })
    const reply = await mind.run("fan out and add")
    expect(reply.error).toBeUndefined()
    expect(reply.output).toBe('"4,6"')
    // The graph existed: two child lanes, each with a served turn.
    const children = ["ag.t1.0", "ag.t1.1"].map((lane) => mind.host.read(lane))
    for (const log of children) {
      expect(log.some((e) => e.type === "TurnCompleted")).toBe(true)
      expect(log.some((e) => e.type === "ReplyDelivered")).toBe(true)
    }
    // And it is quiet: nothing owed anywhere.
    expect(mind.host.resting()).toBe(true)
  })

  test("an agent initialises from a log: history carries, new runs continue past it", async () => {
    // Run one agent to a settled state, carry its log into a fresh one: the resumed agent
    // reads the same history, and a new run serves without colliding with a recorded id.
    const first = createRlmAgent({ infer: scripted })
    await first.run("sum 1+2")
    const carried = first.host.read(ROOT_LANE)

    const resumed = createRlmAgent({ infer: scripted, log: carried })
    expect(resumed.host.read(ROOT_LANE)).toEqual(carried)
    const again = await resumed.run("sum 3+4")
    expect(again.output).toBe("7")
    // Both turns live on one log: the carried terminal and the new one.
    expect(resumed.host.read(ROOT_LANE).filter((e) => e.type === "TurnCompleted")).toHaveLength(2)
    expect(resumed.host.resting()).toBe(true)
  })

  test("a second run reuses the root lane as a genuinely fresh turn", async () => {
    const mind = createRlmAgent({ infer: scripted })
    await mind.run("fan out and add")
    const again = await mind.run("fan out and add")
    expect(again.output).toBe('"4,6"')
    // The second turn ran its own execution and spawned its own children.
    expect(mind.host.read(ROOT_LANE).filter((e) => e.type === "CodeSettled")).toHaveLength(2)
    for (const lane of ["ag.t2.0", "ag.t2.1"]) {
      expect(mind.host.read(lane).some((e) => e.type === "TurnCompleted")).toBe(true)
    }
  })

  test("a native tool surface runs the same turn loop with no code lane", async () => {
    // The benchmark shape: a fixed table of named tools, called directly. Code mode is the
    // default rather than the only surface, so an agent measured against another harness keeps
    // the turn loop, the budget wall, and the answer contract while presenting that harness's
    // tools (surface.ts).
    const reads: string[] = []
    const capabilities = [toolList([
      {
        spec: { name: "read", description: "read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
        run: (input) => {
          const path = String((input as { path?: unknown }).path)
          reads.push(path)
          return Effect.succeed(`contents of ${path}`)
        }
      }
    ])]
    const mind = createRlmAgent({
      capabilities,
      infer: async ({ trajectory }) => {
        const returned = trajectory.find((e) => e.type === "ToolReturned") as { result?: unknown } | undefined
        if (returned !== undefined) return { kind: "complete", output: String(returned.result) }
        return { kind: "call", callId: "n1", name: "read", arguments: { path: "/contract.md" } }
      }
    })
    const answer = await mind.run("read the contract")
    expect(answer.output).toBe("contents of /contract.md")
    expect(reads).toEqual(["/contract.md"])
    // The tool answered directly: no code was ever dispatched.
    const log = mind.host.read(ROOT_LANE)
    expect(log.some((e) => e.type === "CodeDispatched")).toBe(false)
    expect(log.filter((e) => e.type === "ToolReturned")).toHaveLength(1)
  })

  test("a call outside the surface comes back as an unknown tool, never a dead turn", async () => {
    const capabilities = [toolList([
      { spec: { name: "read", description: "read", inputSchema: {} }, run: () => Effect.succeed("ok") }
    ])]
    const mind = createRlmAgent({
      capabilities,
      infer: async ({ trajectory }) => {
        const returned = trajectory.find((e) => e.type === "ToolReturned") as { result?: { error?: string } } | undefined
        if (returned !== undefined) return { kind: "complete", output: String(returned.result?.error) }
        return { kind: "call", callId: "x1", name: "execute", arguments: { code: "return 1" } }
      }
    })
    const answer = await mind.run("go")
    expect(answer.output).toContain("unknown tool: execute")
    expect(answer.output).toContain("read")
  })

  test("the workspace reads back what a spilled result put in the store", async () => {
    // The mounted workspace and the code reactor's spill path hold one store: a result too large
    // for the event spills, and the next body finds it by grep and slices it by ref.
    const mind = createRlmAgent({
      infer: async ({ trajectory }) => {
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
      }
    })
    // The store holds the result's JSON, so the offset counts the opening quote too.
    const answer = await mind.run("spill then search")
    expect(answer.output).toBe("w1.result:20001:NEEDLE:20008")
  })
})
