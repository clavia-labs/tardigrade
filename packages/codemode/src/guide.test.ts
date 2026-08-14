import { describe, expect, test } from "bun:test"
import { Context, Effect } from "effect"
import { Router, type Event } from "@flamecast/core"
import {
  callAgent,
  createAgent,
  customInference,
  defaultPack,
  host,
  treeUsageIn,
  type Action,
  type ModelRequest
} from "@flamecast/harness"
import { inference } from "@flamecast/harness/modules/inference"
import { subagentTool } from "@flamecast/harness/subagent"
import { agents } from "./capabilities/agents"
import { capability } from "./capability"
import { codemode } from "./tool"
import { inProcessSandbox, Sandbox } from "./sandbox"

// The walkthrough in docs/building-a-swarm.md, run. Each test is one section of the guide, with a
// scripted provider standing in for the gateway, so an edit that breaks a snippet breaks here. The
// guide imports from "flamecast-core/*" and this file from "@flamecast/*", because the guide
// addresses an installer of the published package and this file lives in the workspace.

const scripted = (model: string, react: (request: ModelRequest) => Action) =>
  customInference(async (request) => react(request), { id: model, model })

const toolAnswered = (request: ModelRequest) =>
  request.messages.some((message) => message.role === "tool")

const spent = { promptTokens: 2, completionTokens: 3, costUsd: 0.002 }

const worker = (address: string) =>
  createAgent({
    modules: [
      inference({
        provider: scripted(address, () => ({
          kind: "complete",
          output: `${address} done`,
          usage: spent
        }))
      })
    ]
  })

describe("building a swarm, as the guide tells it", () => {
  test("a verifier peer answers with a clean context and the evidence folds home", async () => {
    const lead = createAgent({
      modules: defaultPack({
        inference: {
          provider: scripted("lead", (request) =>
            toolAnswered(request)
              ? { kind: "complete", output: "checked" }
              : { kind: "call", callId: "c-1", name: "verify", arguments: { message: "claim" } }
          )
        },
        nativeTools: [
          subagentTool({
            name: "verify",
            description: "Ask the verifier to check an answer before returning it.",
            address: "agent:verify"
          })
        ]
      })
    })
    const verifier = createAgent({
      modules: [
        inference({
          provider: scripted("verifier", () => ({ kind: "complete", output: "correct", usage: spent }))
        })
      ]
    })
    const h = host({ programs: { "agent:lead": lead, "agent:verify": verifier } })

    const terminal = await Effect.runPromise(h.call("agent:lead", { id: "m-1", text: "go" }))
    expect(terminal).toMatchObject({ type: "TurnCompleted", output: "checked" })

    const childLog = await Effect.runPromise(h.log("agent:verify"))
    const head = childLog.find((event) => event.type === "MessageReceived")
    expect(head?.origin).toMatchObject({ session: "agent:lead", turn: "m-1", call: "c-1" })

    const leadLog = await Effect.runPromise(h.log("agent:lead"))
    expect(treeUsageIn(leadLog, "m-1")).toEqual(spent)
  })

  test("workers spawn by address and fan out from code on Promise.all", async () => {
    const h = host({ programs: { "worker/*": worker } })
    const router = {
      deliver: (address: string, event: Event) => Effect.asVoid(h.route(address, event)),
      call: h.route
    }
    const ask = (address: string, id: string, text: string) =>
      Effect.runPromise(Effect.provideService(callAgent(address, { id, text }), Router, router))

    const answers = await Promise.all([
      ask("worker/1", "r-1", "summarize the first half"),
      ask("worker/2", "r-2", "summarize the second half")
    ])
    expect(answers.map((one) => one.output)).toEqual(["worker/1 done", "worker/2 done"])
    expect(await Effect.runPromise(h.sessions)).toEqual(["worker/1", "worker/2"])
  })

  test("the model writes the fan-out and reaches the application's own capability", async () => {
    const store = new Map<string, string>()
    const notes = capability({
      name: "notes",
      summary: "Shared notes for this run.",
      methods: [
        {
          name: "save",
          signature: "save(key, text): Promise<void>",
          description: "Keep one note under a key.",
          run: (args) => Effect.sync(() => void store.set(String(args[0]), String(args[1])))
        }
      ]
    })
    const execute = codemode({ capabilities: [notes, agents({ allow: ["worker/*"] })] })
    const lead = createAgent({
      modules: defaultPack({
        inference: {
          provider: scripted("lead", (request) =>
            toolAnswered(request)
              ? { kind: "complete", output: "gathered" }
              : {
                  kind: "call",
                  callId: "c-1",
                  name: "execute",
                  arguments: {
                    source: `
                      const answers = await Promise.all([
                        agents.call("worker/1", "summarize the first half"),
                        agents.call("worker/2", "summarize the second half")
                      ])
                      const joined = answers.map((one) => one.output).join("\\n")
                      await notes.save("summary", joined)
                      return joined
                    `
                  }
                }
          )
        },
        nativeTools: [execute]
      })
    })
    const h = host({
      programs: { "agent:lead": lead, "worker/*": worker },
      services: Context.make(Sandbox, inProcessSandbox())
    })

    const terminal = await Effect.runPromise(h.call("agent:lead", { id: "m-1", text: "go" }))
    expect(terminal).toMatchObject({ type: "TurnCompleted", output: "gathered" })
    expect(store.get("summary")).toBe("worker/1 done\nworker/2 done")

    // One model-written script, two delegations, and the spend folds up the tree regardless.
    const leadLog = await Effect.runPromise(h.log("agent:lead"))
    expect(treeUsageIn(leadLog, "m-1").costUsd).toBeCloseTo(0.004, 6)
  })

  test("replyTo delivers the answer later as an attributed inbound message", async () => {
    const lead = createAgent({
      modules: [
        inference({ provider: scripted("lead", () => ({ kind: "complete", output: "ack" })) })
      ]
    })
    const h = host({ programs: { "agent:lead": lead, "worker/*": worker } })
    await Effect.runPromise(
      h.call("worker/9", { id: "j-1", text: "index the archive", replyTo: "agent:lead" })
    )
    const inbox = await Effect.runPromise(h.log("agent:lead"))
    const reply = inbox.find((event) => event.type === "MessageReceived")
    expect(reply).toMatchObject({
      id: "reply:j-1",
      text: "worker/9 done",
      outcome: "completed",
      usage: spent
    })
    expect(reply?.origin).toMatchObject({ session: "worker/9" })
  })
})
