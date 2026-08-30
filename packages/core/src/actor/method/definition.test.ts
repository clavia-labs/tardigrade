import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { Event } from "../../log/event"
import {
  DEFAULT_ACTOR_METHOD_TIMEOUT_MS,
  actorMethod,
  actorMethodsOf,
  type ActorMethodInput,
  type ActorMethodOutput
} from "./definition"
import type { ActorMethodCall } from "./call"
import type { ActorMethodState } from "./state"

const inspect = actorMethod({
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.Struct({ length: Schema.Finite }),
  event: ({ invocation, input, at }): Event => ({ type: "Inspected", id: invocation.id, value: input.value, at }),
  state: (_events, invocation) => ({ status: "completed", output: { length: invocation.id.length } })
})

describe("actorMethod", () => {
  test("resolves an exported timeout and validates an override", () => {
    expect(inspect.timeoutMs).toBe(DEFAULT_ACTOR_METHOD_TIMEOUT_MS)
    expect(actorMethod({ ...inspect, timeoutMs: 12 }).timeoutMs).toBe(12)
    expect(() => actorMethod({ ...inspect, timeoutMs: 0 })).toThrow("timeoutMs")
  })

  test("preserves its decoded input and output types", () => {
    const call: ActorMethodCall<{ readonly value: string }> = {
      invocation: { method: "inspect", id: "call-1", epoch: 0 },
      input: { value: "hello" },
      at: 7
    }
    const accepted: Parameters<typeof inspect.event>[0] = call
    const input: ActorMethodInput<typeof inspect> = call.input
    const output: ActorMethodOutput<typeof inspect> = { length: 6 }
    const state: ActorMethodState<{ readonly length: number }> | undefined = inspect.state([], call.invocation)
    expect(accepted.input).toEqual(input)
    expect(state).toEqual({ status: "completed", output })
  })

  test("builds a durable event after validating dynamic input", () => {
    expect(inspect.eventOf({ invocation: { method: "inspect", id: "call-1", epoch: 0 }, input: { value: "hello" }, at: 7 })).toEqual({
      type: "Inspected",
      id: "call-1",
      value: "hello",
      at: 7
    })
    expect(() => inspect.eventOf({ invocation: { method: "inspect", id: "call-1", epoch: 0 }, input: { value: 42 }, at: 7 })).toThrow()
  })
})

describe("actorMethodsOf", () => {
  test("keeps a named heterogeneous interface", () => {
    const methods = actorMethodsOf({ inspect })
    expect(methods.inspect).toBe(inspect)
  })

  test("refuses an invalid method name", () => {
    expect(() => actorMethodsOf({ "Inspect now": inspect })).toThrow("actor method name must match")
  })

  test("refuses incomplete declarations", () => {
    expect(() => actorMethodsOf({ broken: { ...inspect, output: {} as Schema.ConstraintDecoder<unknown> } })).toThrow(
      "must declare input and output schemas"
    )
    expect(() => actorMethodsOf({ broken: { ...inspect, eventOf: undefined as never } })).toThrow(
      "must declare eventOf, state, and currentEpoch functions"
    )
    expect(() => actorMethodsOf({ broken: { ...inspect, currentEpoch: undefined as never } })).toThrow(
      "must declare eventOf, state, and currentEpoch functions"
    )
    expect(() => actorMethodsOf({ broken: { ...inspect, cancellation: {} as never } })).toThrow(
      "cancellation must declare state and event functions"
    )
  })

  test("refuses two names for one method declaration", () => {
    expect(() => actorMethodsOf({ inspect, alias: inspect })).toThrow(
      'actor methods "inspect" and "alias" share one declaration'
    )
  })
})
