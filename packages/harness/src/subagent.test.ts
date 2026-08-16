import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Event } from "@flamecast/core"
import { InMemoryRuntime } from "@flamecast/runtime-in-memory"
import { keyOf } from "./keys"
import { subagentTool } from "./subagent"

// A registry entry is a function from an event to a terminal event, so a stub target is written
// inline. `*` claims every address the exact keys do not.
const stub = (
  record: (address: string, event: Event) => void,
  answer: (event: Event) => Event
) => ({
  "*": (address: string) => (event: Event) => {
    record(address, event)
    return Effect.succeed(answer(event))
  }
})

describe("subagentTool", () => {
  const delegate = subagentTool({
    name: "ask_researcher",
    description: "Ask the research agent.",
    address: "agent:research"
  })

  test("turns a routed agent into an ordinary tool and stamps the origin", async () => {
    const routed: Array<{ readonly address: string; readonly event: Event }> = []
    const result = await Effect.runPromise(
      Effect.provide(
        delegate.run({ message: "Find the refund policy." }, { turn: "m-1", callId: "c-1" }),
        InMemoryRuntime({
          keyOf,
          session: "agent:supervisor",
          sessions: stub(
            (address, event) => routed.push({ address, event }),
            (event) => ({
              type: "TurnCompleted",
              turn: String(event.id ?? ""),
              output: "Refunds are allowed within 30 days.",
              usage: { promptTokens: 5, completionTokens: 7, costUsd: 0.01 }
            })
          )
        })
      )
    )
    expect(result).toMatchObject({
      agent: "agent:research",
      output: "Refunds are allowed within 30 days.",
      usage: { promptTokens: 5, completionTokens: 7, costUsd: 0.01 }
    })
    expect(routed[0]?.address).toBe("agent:research")
    expect(routed[0]?.event).toMatchObject({
      type: "MessageReceived",
      text: "Find the refund policy.",
      origin: { session: "agent:supervisor", turn: "m-1", call: "c-1" }
    })
  })

  test("uses a deterministic child turn id for the same input", async () => {
    const ids: Array<string> = []
    const layer = InMemoryRuntime({
      keyOf,
      sessions: stub(
        (_, event) => ids.push(String(event.id)),
        () => ({ type: "TurnCompleted", output: "ok" })
      )
    })
    await Effect.runPromise(Effect.provide(delegate.run({ message: "same" }), layer))
    await Effect.runPromise(Effect.provide(delegate.run({ message: "same" }), layer))
    expect(ids[0]).toBe(ids[1])
  })

  test("names the child turn by the parent turn and provider call", async () => {
    const ids: Array<string> = []
    const layer = InMemoryRuntime({
      keyOf,
      sessions: stub(
        (_, event) => ids.push(String(event.id)),
        () => ({ type: "TurnCompleted", output: "ok" })
      )
    })
    await Effect.runPromise(
      Effect.provide(delegate.run({ message: "same" }, { turn: "m-1", callId: "c-1" }), layer)
    )
    await Effect.runPromise(
      Effect.provide(delegate.run({ message: "same" }, { turn: "m-2", callId: "c-1" }), layer)
    )
    expect(ids).toEqual(["ask_researcher:m-1:c-1", "ask_researcher:m-2:c-1"])
  })

  test("a failed child turn is an error value with the child's spend", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        delegate.run({ message: "hard question" }),
        InMemoryRuntime({
          keyOf,
          sessions: stub(
            () => {},
            () => ({
              type: "TurnFailed",
              error: "the model attempt died 3 times in a row",
              usage: { promptTokens: 9, completionTokens: 0, costUsd: 0.02 }
            })
          )
        })
      )
    )
    expect(result).toMatchObject({
      error: "the model attempt died 3 times in a row",
      usage: { promptTokens: 9, completionTokens: 0, costUsd: 0.02 }
    })
  })

  test("an address no session serves is a failed turn, never a hang", async () => {
    const result = await Effect.runPromise(
      Effect.provide(delegate.run({ message: "hello" }), InMemoryRuntime({ keyOf }))
    )
    expect(String((result as { error?: unknown }).error)).toContain(
      'no session serves "agent:research"'
    )
  })

  test("rejects malformed arguments before routing", async () => {
    let routed = false
    const result = await Effect.runPromise(
      Effect.provide(
        delegate.run({}),
        InMemoryRuntime({
          keyOf,
          sessions: stub(
            () => {
              routed = true
            },
            () => ({ type: "TurnCompleted", output: "unexpected" })
          )
        })
      )
    )
    expect(result).toHaveProperty("error")
    expect(String((result as { error?: unknown }).error)).toContain("did not match")
    expect(routed).toBe(false)
  })
})
