import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import fc from "fast-check"
import type { Event } from "@clavia/tardigrade-core/event"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import {
  DEFAULT_ACTOR_METHOD_TIMEOUT_MS,
  actorMethod,
  actorMethodsOf,
  type ActorMethodInput,
  type ActorMethodOutput
} from "./method"
import { legacyActorMethod } from "./legacy"
import type { ActorMethodCall } from "./call"
import type { ActorMethodState } from "./state"

const inspect = legacyActorMethod({
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.Struct({ length: Schema.Finite }),
  event: ({ invocation, input, at }): Event => ({ type: "Inspected", id: invocation.id, value: input.value, at }),
  state: (_events, invocation) => ({ status: "completed", output: { length: invocation.id.length } })
})

describe("actorMethod", () => {
  test("resolves an exported timeout and validates an override", () => {
    expect(inspect.timeoutMs).toBe(DEFAULT_ACTOR_METHOD_TIMEOUT_MS)
    expect(legacyActorMethod({ ...inspect, timeoutMs: 12 }).timeoutMs).toBe(12)
    expect(() => legacyActorMethod({ ...inspect, timeoutMs: 0 })).toThrow("timeoutMs")
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

  test("a method projection refines its complete-history specification", () => {
    const stateFrom = (events: ReadonlyArray<Event>, id: string): ActorMethodState<void> | undefined => {
      if (!events.some((event) => event.type === "Started" && event.id === id)) return undefined
      return events.some((event) => event.type === "Finished" && event.id === id)
        ? { status: "completed", output: undefined }
        : { status: "pending" }
    }
    const complete = legacyActorMethod({
      input: Schema.Void,
      output: Schema.Void,
      event: ({ invocation, at }): Event => ({ type: "Started", id: invocation.id, at }),
      state: (events, invocation) => stateFrom(events, invocation.id)
    })
    const incremental = actorMethod({
      input: Schema.Void,
      output: Schema.Void,
      event: ({ invocation, at }): Event => ({ type: "Started", id: invocation.id, at }),
      projection: {
        initial: () => ({ started: new Set<string>(), finished: new Set<string>() }),
        step: (state, event) => {
          const started = new Set(state.started)
          const finished = new Set(state.finished)
          if (event.type === "Started") started.add(String(event.id))
          if (event.type === "Finished") finished.add(String(event.id))
          return { started, finished }
        },
        output: (state) => ({
          currentEpoch: () => 0,
          invocationState: (invocation) => {
            if (!state.started.has(invocation.id)) return undefined
            return state.finished.has(invocation.id)
              ? { status: "completed" as const, output: undefined }
              : { status: "pending" as const }
          }
        })
      }
    })
    fc.assert(fc.property(
      fc.array(fc.record({
        type: fc.constantFrom("Started", "Finished", "Ignored"),
        id: fc.string({ maxLength: 4 }),
        at: fc.nat()
      }), { maxLength: 40 }),
      fc.string({ maxLength: 4 }),
      (events, id) => {
        const log = events as ReadonlyArray<Event>
        const invocation = { method: "work", id, epoch: 0 }
        const view = replayProjection(incremental.projection, log)
        expect(view.invocationState(invocation)).toEqual(complete.state(log, invocation))
        expect(view.currentEpoch(id)).toBe(complete.currentEpoch(log, id))
      }
    ))
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
      "cancellation must declare an event function"
    )
  })

  test("refuses two names for one method declaration", () => {
    expect(() => actorMethodsOf({ inspect, alias: inspect })).toThrow(
      'actor methods "inspect" and "alias" share one declaration'
    )
  })
})
