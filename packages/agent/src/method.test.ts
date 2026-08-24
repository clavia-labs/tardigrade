import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import {
  actorMethod,
  actorMethodsOf,
  type ActorMethodCall,
  type ActorMethodInput,
  type ActorMethodOutput,
  type ActorMethodState
} from "./method"

const inspect = actorMethod({
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.Struct({ length: Schema.Finite }),
  event: ({ id, input, at }): Event => ({ type: "Inspected", id, value: input.value, at }),
  state: (_events, id) => ({ status: "completed", output: { length: id.length } })
})

describe("actorMethod", () => {
  test("preserves its decoded input and output types", () => {
    const call: ActorMethodCall<{ readonly value: string }> = {
      id: "call-1",
      input: { value: "hello" },
      at: 7
    }
    const accepted: Parameters<typeof inspect.event>[0] = call
    const input: ActorMethodInput<typeof inspect> = call.input
    const output: ActorMethodOutput<typeof inspect> = { length: 6 }
    const state: ActorMethodState<{ readonly length: number }> | undefined = inspect.state([], call.id)
    expect(accepted.input).toEqual(input)
    expect(state).toEqual({ status: "completed", output })
  })

  test("builds the durable input event and projects its current state", () => {
    expect(inspect.event({ id: "call-1", input: { value: "hello" }, at: 7 })).toEqual({
      type: "Inspected",
      id: "call-1",
      value: "hello",
      at: 7
    })
    expect(inspect.state([], "call-1")).toEqual({ status: "completed", output: { length: 6 } })
  })

  test("builds an event from dynamically typed input only after decoding it", () => {
    expect(inspect.eventOf({ id: "call-1", input: { value: "hello" }, at: 7 })).toEqual({
      type: "Inspected",
      id: "call-1",
      value: "hello",
      at: 7
    })
    expect(() => inspect.eventOf({ id: "call-1", input: { value: 42 }, at: 7 })).toThrow()
  })
})

describe("actorMethodsOf", () => {
  test("keeps a named heterogeneous interface", () => {
    const methods = actorMethodsOf({ inspect })
    expect(methods.inspect).toBe(inspect)
  })

  test("refuses a name that cannot become an invocation surface", () => {
    expect(() => actorMethodsOf({ "Inspect now": inspect })).toThrow("actor method name must match")
  })

  test("refuses a method without both schemas", () => {
    expect(() => actorMethodsOf({
      broken: { ...inspect, output: {} as Schema.Top }
    })).toThrow("must declare input and output schemas")
  })

  test("refuses a method without its event builder and state function", () => {
    expect(() => actorMethodsOf({
      broken: { ...inspect, eventOf: undefined as never }
    })).toThrow("must declare eventOf and state functions")
  })
})
