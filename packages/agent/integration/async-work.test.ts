import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { actor } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/event"
import { parseThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { alarm } from "@clavia/tardigrade-code/package/alarm"
import { definePackage } from "@clavia/tardigrade-code/package/definition"
import { jsSandboxFor } from "@clavia/tardigrade-code/sandbox/defaults"
import { createHost } from "@clavia/tardigrade-host/host"
import { testInferenceLayer } from "../fixtures/model"
import { agentMethods, codeMode, infer, outputValidateOnce } from "../src/index"
import type { InferRequest } from "../src/model/contract"
import type { Action } from "../src/log/events"
import { agentsPackage } from "../src/packages/agents"
import { tools } from "../src/component/tool/index"

// These tests describe work that finishes after the turn that started it. A shape marked test-local is a placeholder, so maintainers can choose the public surface. The assertions read only the log and what the host observes.

const MODELS = { models: { default: { provider: "test", model_id: "fixture" }, allow: "*" } } as const

type Mind = (turn: { readonly id: string; readonly text: string; readonly events: ReadonlyArray<Event> }) => Action

// headOf reads the current turn: its opening message and the events that carry its id.
const headOf = (request: InferRequest) => {
  const head = [...request.trajectory].reverse().find(event => event.type === "MessageReceived")
  const id = String(head?.id ?? "")
  const text = typeof head?.text === "string" ? head.text : JSON.stringify(head ?? null)
  return { id, text, events: request.trajectory.filter(event => event === head || event.turn === id) }
}

const hostFor = (components: Parameters<typeof infer>[0], mind: Mind, extra: object = {}) => {
  let modelCalls = 0
  // components is widened across cases, so the actor's requirements read as unknown and the layer is cast.
  const options = {
    actorName: "async-work",
    actorFor: () => actor({ name: "async-work", methods: agentMethods, components: [infer(components, MODELS)] }),
    layersFor: () => Layer.mergeAll(KeyValueStore.layerMemory, jsSandboxFor({}), testInferenceLayer({
      react: request => Effect.sync(() => { modelCalls++; return mind(headOf(request)) })
    })) as never
  }
  const host = createHost(Object.assign(options, extra))
  const start = async (text: string) => {
    await host.allocate({ kind: "root", coordinate: parseThreadAddress(host.self("root")) })
    await host.commitRoot(host.self("root"), { type: "MessageReceived", id: "m1", text, at: 1 })
  }
  return { host, start, modelCalls: () => modelCalls }
}

const turnsOf = (log: ReadonlyArray<Event>) => log.filter(event => event.type === "MessageReceived")
const completed = (log: ReadonlyArray<Event>, turn: unknown) => log.some(event => event.type === "TurnCompleted" && event.turn === turn)
const mentions = (value: unknown, text: string) => JSON.stringify(value ?? null).includes(text)

// until polls because the work under test finishes outside any drive the test awaits.
const until = async (ready: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms
  while (!ready() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10))
  return ready()
}

describe("a background package call starts a new turn with its result", () => {
  test.failing("the first turn completes while the call runs, and its result opens the next turn", async () => {
    const job = Promise.withResolvers<string>()
    const bash = definePackage({
      name: "bash",
      description: "long shell job",
      // The background opt-in is test-local.
      annotations: { run: { background: true } as never },
      methods: { run: () => Effect.promise(() => job.promise) }
    })
    const { host, start } = hostFor([tools([bash]), outputValidateOnce], turn =>
      turn.id !== "m1" ? { kind: "complete", output: `saw ${turn.text}` }
        : turn.events.some(event => event.type === "ToolReturned") ? { kind: "complete", output: "started" }
          : { kind: "calls", calls: [{ callId: "job", name: "bash_run", arguments: {} }] })
    try {
      await start("run the job")
      const drained = await Promise.race([host.drive().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 500))])
      expect(drained).toBe(true)
      expect(completed(host.read("root"), "m1")).toBe(true)
      job.resolve("job-output-42")
      expect(await until(() => turnsOf(host.read("root")).length === 2)).toBe(true)
      await host.drive()
      const next = turnsOf(host.read("root"))[1]!
      expect(mentions(next, "job-output-42")).toBe(true)
      expect(completed(host.read("root"), next.id)).toBe(true)
    } finally {
      job.resolve("job-output-42")
    }
  })
})

describe("a finished child starts a turn on its root", () => {
  test.failing("a background child that answers after the root turn ended opens a new root turn with the answer", async () => {
    const { host, start } = hostFor([codeMode([agentsPackage({ budget: {} })]), outputValidateOnce], turn => {
      if (turn.text === "child job") return { kind: "complete", output: "child-answer-7" }
      if (turn.id !== "m1") return { kind: "complete", output: `saw ${turn.text}` }
      return turn.events.some(event => event.type === "ToolReturned")
        ? { kind: "complete", output: "spawned" }
        : { kind: "calls", calls: [{ callId: "spawn", name: "execute", arguments: {
          code: `const run = await agents.run({ text: "child job", background: true }); return run.handle !== undefined` } }] }
    })
    await start("spawn a child")
    await host.drive()
    const log = host.read("root")
    expect(completed(log, "m1")).toBe(true)
    const next = turnsOf(log).find(event => event.id !== "m1")
    expect(mentions(next, "child-answer-7")).toBe(true)
    expect(completed(log, next?.id)).toBe(true)
  })
})

describe("the host sees a turn that the actor starts by itself", () => {
  // admit is a test-local host option: it is asked before a turn that no host call started is run.
  const wakeAgent = (admit: (thread: string, turn: Event) => boolean) => hostFor(({ message }) => [
    tools([alarm({ onFired: fired => message({ text: fired.note }) })]), outputValidateOnce
  ], turn => turn.id !== "m1" ? { kind: "complete", output: `woke: ${turn.text}` }
    : turn.events.some(event => event.type === "ToolReturned") ? { kind: "complete", output: "scheduled" }
      : { kind: "calls", calls: [{ callId: "set", name: "alarm_set", arguments: { wakeAt: Date.now() + 20, note: "check the job" } }] },
  { admit })

  test.failing("an alarm-started turn is offered to the host before it runs", async () => {
    const offered: Array<Event> = []
    const { host, start } = wakeAgent((_thread, turn) => { offered.push(turn); return true })
    await start("remind me")
    await host.drive()
    expect(await until(() => completed(host.read("root"), turnsOf(host.read("root"))[1]?.id))).toBe(true)
    expect(offered.map(turn => turn.text)).toEqual(["check the job"])
  })

  test.failing("a turn the host refuses never reaches the model", async () => {
    const { host, start, modelCalls } = wakeAgent(() => false)
    await start("remind me")
    await host.drive()
    const calls = modelCalls()
    await until(() => turnsOf(host.read("root")).length > 1, 300)
    await host.drive()
    expect(modelCalls()).toBe(calls)
    expect(turnsOf(host.read("root")).map(turn => turn.id)).toEqual(["m1"])
  })
})
