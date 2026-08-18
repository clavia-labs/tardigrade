import { describe, expect, test } from "bun:test"
import type { Event } from "@flamecast/core/event"
import type { Action } from "./events"
import { createRlmAgent } from "./index"

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
const scripted = async (trajectory: ReadonlyArray<Event>): Promise<Action> => {
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
})
