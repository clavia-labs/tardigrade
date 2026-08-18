import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Router, Sessions, type Event } from "@flamecast/core"
import { InMemoryRuntime } from "@flamecast/runtime-in-memory"
import { customInference, type Action, type ModelRequest } from "./infer"
import { keyOf } from "./keys"
import { createAgent, type MessageOrigin } from "./module"
import { inference } from "./modules/inference"
import { nativeTools } from "./modules/native-tools"
import { serve } from "./serve"
import { subagentTool, type SubagentResult } from "./subagent"
import { treeUsageIn } from "./turns"

const scripted = (model: string, react: (request: ModelRequest) => Action) =>
  customInference(async (request) => react(request), { id: model, model, contextWindow: 200_000 })

const toolAnswered = (request: ModelRequest) =>
  request.messages.some((message) => message.role === "tool")

// The caller of a swarm is an ordinary effect over the runtime's ports. There is no host object:
// the registry is runtime configuration and `Router` is how anything reaches an address.
const ask = (address: string, id: string, text: string) =>
  Effect.flatMap(Router, (router) =>
    router.call(address, { type: "MessageReceived", id, text })
  )

const readLog = (address: string) => Effect.flatMap(Sessions, (sessions) => sessions.read(address))

describe("serve", () => {
  test("delegation crosses sessions with origin out and tree usage home", async () => {
    const supervisor = createAgent({
      modules: [
        inference({
          provider: scripted("opus", (request) =>
            toolAnswered(request)
              ? { kind: "complete", output: "verified" }
              : { kind: "call", callId: "c-1", name: "ask_verify", arguments: { message: "check" } }
          )
        }),
        nativeTools([
          subagentTool({
            name: "ask_verify",
            description: "Ask the verifier.",
            address: "agent:verify"
          })
        ])
      ]
    })
    const verifier = createAgent({
      modules: [
        inference({
          provider: scripted("haiku", () => ({
            kind: "complete",
            output: "looks correct",
            usage: { promptTokens: 5, completionTokens: 7, costUsd: 0.01 }
          }))
        })
      ]
    })
    const runtime = InMemoryRuntime({
      keyOf,
      sessions: { "agent:supervisor": serve(supervisor), "agent:verify": serve(verifier) }
    })

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const terminal = yield* ask("agent:supervisor", "m-1", "go")
          return {
            terminal,
            childLog: yield* readLog("agent:verify"),
            parentLog: yield* readLog("agent:supervisor")
          }
        }),
        runtime
      )
    )

    expect(result.terminal).toMatchObject({
      type: "TurnCompleted",
      output: "verified",
      usage: { completionTokens: 7, settled: { completionTokens: 7, costUsd: 0.01, promptTokens: 5 } }
    })
    const head = result.childLog.find((event) => event.type === "MessageReceived")
    expect(head?.origin).toEqual({ session: "agent:supervisor", turn: "m-1", call: "c-1" })
    expect(String(head?.id)).toBe("ask_verify:m-1:c-1")
    expect(treeUsageIn(result.parentLog, "m-1")).toMatchObject({
      promptTokens: 5,
      completionTokens: 7,
      costUsd: 0.01
    })
  })

  test("a redelivered message opens no second turn", async () => {
    const echo = createAgent({
      modules: [
        inference({ provider: scripted("haiku", () => ({ kind: "complete", output: "once" })) })
      ]
    })
    const runtime = InMemoryRuntime({ keyOf, sessions: { "agent:echo": serve(echo) } })
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const first = yield* ask("agent:echo", "m-1", "hi")
          const before = (yield* readLog("agent:echo")).length
          const second = yield* ask("agent:echo", "m-1", "hi")
          return { first, second, before, after: (yield* readLog("agent:echo")).length }
        }),
        runtime
      )
    )
    expect(result.first).toMatchObject({ type: "TurnCompleted", output: "once" })
    expect(result.second).toMatchObject({ type: "TurnCompleted", output: "once" })
    expect(result.after).toBe(result.before)
  })

  test("a delegation cycle fails fast instead of deadlocking", async () => {
    const bouncer = (name: string, other: string) =>
      createAgent({
        modules: [
          inference({
            provider: scripted(name, (request) =>
              toolAnswered(request)
                ? { kind: "complete", output: `${name} done` }
                : { kind: "call", callId: "c-1", name: "bounce", arguments: { message: "back" } }
            )
          }),
          nativeTools([subagentTool({ name: "bounce", description: "Bounce.", address: other })])
        ]
      })
    const runtime = InMemoryRuntime({
      keyOf,
      sessions: {
        "agent:a": serve(bouncer("a", "agent:b")),
        "agent:b": serve(bouncer("b", "agent:a"))
      }
    })
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const terminal = yield* ask("agent:a", "m-1", "go")
          return { terminal, bLog: yield* readLog("agent:b") }
        }),
        runtime
      )
    )
    expect(result.terminal).toMatchObject({ type: "TurnCompleted", output: "a done" })
    const bounced = result.bLog.find((event) => event.type === "ToolReturned")?.result as
      | SubagentResult
      | undefined
    expect(String(bounced?.error)).toContain("delegation cycle")
  })

  test("recursion stops at the depth bound, derived from origins", async () => {
    const deeper = (address: string) => {
      const depth = Number(address.split("/")[1])
      return serve(
        createAgent({
          modules: [
            inference({
              provider: scripted(`loop-${depth}`, (request) =>
                toolAnswered(request)
                  ? { kind: "complete", output: `stopped at ${depth}` }
                  : { kind: "call", callId: "c-1", name: "deeper", arguments: { message: "go" } }
              )
            }),
            nativeTools([
              subagentTool({
                name: "deeper",
                description: "Go one level deeper.",
                address: `loop/${depth + 1}`
              })
            ])
          ]
        }),
        { maxDepth: 3 }
      )
    }
    const runtime = InMemoryRuntime({ keyOf, sessions: { "loop/*": deeper } })
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const terminal = yield* ask("loop/0", "l-0", "go")
          const sessions = yield* Sessions
          return { terminal, list: yield* sessions.list, deepest: yield* readLog("loop/2") }
        }),
        runtime
      )
    )
    expect(result.terminal.type).toBe("TurnCompleted")
    expect(result.list).toContain("loop/2")
    expect(result.list).not.toContain("loop/3")
    const refused = result.deepest.find((event) => event.type === "ToolReturned")?.result as
      | SubagentResult
      | undefined
    expect(String(refused?.error)).toContain("delegation depth")
  })

  test("the async door replies with origin and usage attached", async () => {
    const worker = createAgent({
      modules: [
        inference({
          provider: scripted("worker", () => ({
            kind: "complete",
            output: "background result",
            usage: { promptTokens: 3, completionTokens: 4, costUsd: 0.005 }
          }))
        })
      ]
    })
    const collector = createAgent({
      modules: [
        inference({ provider: scripted("collector", () => ({ kind: "complete", output: "ack" })) })
      ]
    })
    const runtime = InMemoryRuntime({
      keyOf,
      sessions: { "agent:worker": serve(worker), "agent:collector": serve(collector) }
    })
    const inbox = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Router).call("agent:worker", {
            type: "MessageReceived",
            id: "j-1",
            text: "work in the background",
            replyTo: "agent:collector"
          })
          return yield* readLog("agent:collector")
        }),
        runtime
      )
    )
    const reply = inbox.find((event: Event) => event.type === "MessageReceived")
    expect(String(reply?.id)).toBe("reply:j-1")
    expect(String(reply?.text)).toBe("background result")
    const from = reply?.origin as MessageOrigin | undefined
    expect(from?.session).toBe("agent:worker")
    expect(reply?.usage).toMatchObject({ promptTokens: 3, completionTokens: 4, costUsd: 0.005 })
  })

  test("an inherited name is not a session", async () => {
    // A pattern lets a model choose the address, and every plain object answers to `constructor`
    // and `toString`. Resolving one would call it as what serves the address.
    const runtime = InMemoryRuntime({ keyOf, sessions: {} })
    for (const address of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      const terminal = await Effect.runPromise(
        Effect.provide(ask(address, "m-1", "hi"), runtime)
      )
      expect(terminal.type).toBe("TurnFailed")
      expect(String(terminal.error)).toContain(`no session serves "${address}"`)
    }
  })
})
