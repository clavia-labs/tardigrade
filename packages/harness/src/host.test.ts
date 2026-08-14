import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Router, type Event } from "@flamecast/core"
import { customInference, type Action, type ModelRequest } from "./infer"
import { host } from "./host"
import { createAgent, type MessageOrigin } from "./module"
import { inference } from "./modules/inference"
import { nativeTools } from "./modules/native-tools"
import { callAgent, subagentTool, type SubagentResult } from "./subagent"
import { treeUsageIn } from "./turns"

const scripted = (model: string, react: (request: ModelRequest) => Action) =>
  customInference(async (request) => react(request), { id: model, model })

const toolAnswered = (request: ModelRequest) =>
  request.messages.some((message) => message.role === "tool")

describe("host", () => {
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
    const h = host({ programs: { "agent:supervisor": supervisor, "agent:verify": verifier } })

    const terminal = await Effect.runPromise(h.call("agent:supervisor", { id: "m-1", text: "go" }))
    expect(terminal).toMatchObject({
      type: "TurnCompleted",
      output: "verified",
      usage: { promptTokens: 5, completionTokens: 7, costUsd: 0.01 }
    })

    const childLog = await Effect.runPromise(h.log("agent:verify"))
    const head = childLog.find((event) => event.type === "MessageReceived")
    expect(head?.origin).toEqual({ session: "agent:supervisor", turn: "m-1", call: "c-1" })
    expect(String(head?.id)).toBe("ask_verify:m-1:c-1")

    const parentLog = await Effect.runPromise(h.log("agent:supervisor"))
    const returned = parentLog.find((event) => event.type === "ToolReturned")?.result as
      | SubagentResult
      | undefined
    expect(returned?.usage.costUsd).toBe(0.01)
    expect(treeUsageIn(parentLog, "m-1")).toEqual({
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
    const h = host({ programs: { "agent:echo": echo } })
    const first = await Effect.runPromise(h.call("agent:echo", { id: "m-1", text: "hi" }))
    const before = (await Effect.runPromise(h.log("agent:echo"))).length
    const second = await Effect.runPromise(h.call("agent:echo", { id: "m-1", text: "hi" }))
    const after = (await Effect.runPromise(h.log("agent:echo"))).length
    expect(first).toMatchObject({ type: "TurnCompleted", output: "once" })
    expect(second).toMatchObject({ type: "TurnCompleted", output: "once" })
    expect(after).toBe(before)
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
          nativeTools([
            subagentTool({ name: "bounce", description: "Bounce.", address: other })
          ])
        ]
      })
    const h = host({
      programs: {
        "agent:a": bouncer("a", "agent:b"),
        "agent:b": bouncer("b", "agent:a")
      }
    })
    const terminal = await Effect.runPromise(h.call("agent:a", { id: "m-1", text: "go" }))
    expect(terminal).toMatchObject({ type: "TurnCompleted", output: "a done" })
    const bLog = await Effect.runPromise(h.log("agent:b"))
    const bounced = bLog.find((event) => event.type === "ToolReturned")?.result as
      | SubagentResult
      | undefined
    expect(String(bounced?.error)).toContain("delegation cycle")
  })

  test("recursion stops at the depth bound, derived from origins", async () => {
    const h = host({
      maxDepth: 3,
      programs: {
        "loop/*": (address) => {
          const depth = Number(address.split("/")[1])
          return createAgent({
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
          })
        }
      }
    })
    const terminal = await Effect.runPromise(h.call("loop/0", { id: "l-0", text: "go" }))
    expect(terminal.type).toBe("TurnCompleted")
    const sessions = await Effect.runPromise(h.sessions)
    expect(sessions).toContain("loop/2")
    expect(sessions).not.toContain("loop/3")
    const deepest = await Effect.runPromise(h.log("loop/2"))
    const refused = deepest.find((event) => event.type === "ToolReturned")?.result as
      | SubagentResult
      | undefined
    expect(String(refused?.error)).toContain("delegation depth")
  })

  test("fan-out is plain code: two calls, two sessions, one join", async () => {
    const h = host({
      programs: {
        "researcher/*": (address) =>
          createAgent({
            modules: [
              inference({
                provider: scripted(`worker-${address}`, () => ({
                  kind: "complete",
                  output: `${address} done`,
                  usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.001 }
                }))
              })
            ]
          })
      }
    })
    const hostRouter = {
      deliver: (address: string, event: Event) => Effect.asVoid(h.route(address, event)),
      call: h.route
    }
    const gathered = await Promise.all([
      Effect.runPromise(
        Effect.provideService(callAgent("researcher/1", { id: "r-1", text: "alpha" }), Router, hostRouter)
      ),
      Effect.runPromise(
        Effect.provideService(callAgent("researcher/2", { id: "r-2", text: "beta" }), Router, hostRouter)
      )
    ])
    expect(gathered.map((result) => result.output)).toEqual([
      "researcher/1 done",
      "researcher/2 done"
    ])
    expect(await Effect.runPromise(h.sessions)).toEqual(["researcher/1", "researcher/2"])
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
    const h = host({ programs: { "agent:worker": worker, "agent:collector": collector } })
    await Effect.runPromise(
      h.call("agent:worker", { id: "j-1", text: "work in the background", replyTo: "agent:collector" })
    )
    const inbox = await Effect.runPromise(h.log("agent:collector"))
    const reply = inbox.find((event) => event.type === "MessageReceived")
    expect(String(reply?.id)).toBe("reply:j-1")
    expect(String(reply?.text)).toBe("background result")
    const from = reply?.origin as MessageOrigin | undefined
    expect(from?.session).toBe("agent:worker")
    expect(reply?.usage).toMatchObject({ promptTokens: 3, completionTokens: 4, costUsd: 0.005 })
  })

  test("an unknown address is a failed turn, never a hang", async () => {
    const h = host({ programs: {} })
    const terminal = await Effect.runPromise(h.call("agent:ghost", { id: "m-1", text: "hi" }))
    expect(terminal.type).toBe("TurnFailed")
    expect(String(terminal.error)).toContain('no program at "agent:ghost"')
  })
})
