import { describe, expect, test } from "bun:test"
import { deriveComponent } from "@clavia/tardigrade-core/component"
import { componentContractOf } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { requestAskMethod } from "../actor/ask"
import { askAuthority, askAuthorityKeys } from "./ask-authority"

const schema = {
  type: "object",
  properties: { approved: { type: "boolean" } },
  required: ["approved"],
  additionalProperties: false
}

const received: Event = {
  type: "AskRequestReceived",
  id: "ask-1",
  request: "tool-1",
  turn: "run-1",
  prompt: "Approve the release?",
  schema,
  at: 1
}

const eventsOf = (
  component: ReturnType<typeof askAuthority> | ReturnType<typeof askAuthority.manual>,
  log: ReadonlyArray<Event>
): ReadonlyArray<Event> => {
  const transition = deriveComponent(component, log).transitions[0]
  if (transition === undefined) return []
  expect(transition.kind).toBe("intent")
  return transition.kind === "intent" ? transition.events(transition.input, 2) : []
}

describe("askAuthority", () => {
  test("records a local answer and then rests", () => {
    const component = askAuthority({ decide: (request) => request.answer({ approved: true }) })
    const events = eventsOf(component, [received])

    expect(events).toMatchObject([{
      type: "AskRequestDecided",
      callId: "ask-1",
      denied: false,
      answer: { approved: true },
      at: 2
    }])
    expect(askAuthorityKeys.keyOf(events[0]!)).toBe("aa:ask-1")
    expect(deriveComponent(component, [received, ...events]).transitions).toEqual([])
    expect(componentContractOf(component).handles).toEqual([{
      method: requestAskMethod,
      handling: "local"
    }])
  })

  test("records a local denial", () => {
    const component = askAuthority({ decide: (request) => request.deny("needs review") })
    const events = eventsOf(component, [received])

    expect(events).toMatchObject([{
      type: "AskRequestDecided",
      callId: "ask-1",
      denied: true,
      reason: "needs review",
      at: 2
    }])
  })

  test("turns an invalid answer into a durable method failure", () => {
    const component = askAuthority({ decide: (request) => request.answer({ approved: "yes" }) })
    const events = eventsOf(component, [received])

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(expect.objectContaining({
      type: "AskRequestFailed",
      callId: "ask-1",
      error: expect.stringContaining("ask answer misses the schema")
    }))
  })

  test("a manual authority declares external handling and schedules no decision", () => {
    const component = askAuthority.manual()

    expect(deriveComponent(component, [received]).transitions).toEqual([])
    expect(componentContractOf(component).handles).toEqual([{
      method: requestAskMethod,
      handling: "external"
    }])
  })
})
