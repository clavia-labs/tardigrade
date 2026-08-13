import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Envelope } from "@flamecast/core"
import { MemoryRuntime } from "@flamecast/runtime-memory"
import { keyOf } from "../keys"
import { agentTool } from "./tools"

describe("agentTool", () => {
  test("turns a routed agent into an ordinary tool", async () => {
    const routed: Array<{ readonly address: string; readonly event: Envelope }> = []
    const delegate = agentTool({
      name: "ask_researcher",
      description: "Ask the research agent.",
      address: "agent:research"
    })
    const result = await Effect.runPromise(
      Effect.provide(
        delegate.run({ message: "Find the refund policy." }),
        MemoryRuntime({
          keyOf,
          route: (address, event) => {
            routed.push({ address, event })
            return Effect.succeed({
              type: "TurnCompleted",
              turn: String(event.id ?? ""),
              output: "Refunds are allowed within 30 days."
            })
          }
        })
      )
    )
    expect(result).toBe("Refunds are allowed within 30 days.")
    expect(routed[0]?.address).toBe("agent:research")
    expect(routed[0]?.event).toMatchObject({
      type: "MessageReceived",
      text: "Find the refund policy."
    })
  })

  test("uses a deterministic call id for the same input", async () => {
    const ids: Array<string> = []
    const delegate = agentTool({
      name: "ask_researcher",
      description: "Ask the research agent.",
      address: "agent:research"
    })
    const layer = MemoryRuntime({
      keyOf,
      route: (_, event) => {
        ids.push(String(event.id))
        return Effect.succeed({ type: "TurnCompleted", output: "ok" })
      }
    })
    await Effect.runPromise(Effect.provide(delegate.run({ message: "same" }), layer))
    await Effect.runPromise(Effect.provide(delegate.run({ message: "same" }), layer))
    expect(ids[0]).toBe(ids[1])
  })

  test("names routed work by the parent turn and provider call", async () => {
    const ids: Array<string> = []
    const delegate = agentTool({
      name: "ask_researcher",
      description: "Ask the research agent.",
      address: "agent:research"
    })
    const layer = MemoryRuntime({
      keyOf,
      route: (_, event) => {
        ids.push(String(event.id))
        return Effect.succeed({ type: "TurnCompleted", output: "ok" })
      }
    })
    await Effect.runPromise(
      Effect.provide(delegate.run({ message: "same" }, { turn: "m-1", callId: "c-1" }), layer)
    )
    await Effect.runPromise(
      Effect.provide(delegate.run({ message: "same" }, { turn: "m-2", callId: "c-1" }), layer)
    )
    expect(ids).toEqual(["ask_researcher:m-1:c-1", "ask_researcher:m-2:c-1"])
  })
})
