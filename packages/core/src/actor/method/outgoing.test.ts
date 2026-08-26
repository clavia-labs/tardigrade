import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import type { Event } from "../../log/event"
import { EventLog, withWatermark } from "../../log"
import { actorIdOf } from "../../communication/endpoint"
import { Router } from "../../communication/router"
import { Self } from "../../reconciliation"
import { actorMethod } from "./definition"
import { actorCall } from "./outgoing"

const inspect = actorMethod({
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.String,
  event: ({ id, input, at }): Event => ({ type: "InspectionRequested", id, value: input.value, at }),
  state: () => ({ status: "pending" })
})

const source = actorIdOf("caller", "root")
const target = {
  address: actorIdOf("inspector", "shared"),
  methods: { inspect }
}

describe("actorCall", () => {
  test("dispatches one typed method call and projects its durable future", async () => {
    const sent: unknown[] = []
    const call = actorCall([], {
      id: "inspect-1",
      target,
      method: "inspect",
      input: { value: "release" }
    })
    expect(call.state).toEqual({ status: "pending" })
    expect(call.transitions).toHaveLength(1)
    const transition = call.transitions[0]!
    expect(transition.kind).toBe("effect")
    if (transition.kind !== "effect") return

    const returned = await Effect.runPromise(transition.act(transition.input).pipe(Effect.provide(Layer.mergeAll(
      Layer.succeed(Self, source),
      Layer.succeed(Router, { send: (envelope) => Effect.sync(() => void sent.push(envelope)) }),
      Layer.succeed(EventLog, withWatermark({ append: () => Effect.void, read: Effect.succeed([]) }))
    ))))

    expect(sent).toEqual([expect.objectContaining({
      link: { source, target: target.address },
      call: { method: "inspect", id: "inspect-1" },
      event: expect.objectContaining({ type: "InspectionRequested", id: "inspect-1", value: "release" })
    })])
    expect(returned).toEqual([expect.objectContaining({
      type: "CallDispatched",
      id: "inspect-1",
      method: "inspect",
      target: "inspector:shared",
      input: { value: "release" }
    })])

    const pending = actorCall(returned, {
      id: "inspect-1",
      target,
      method: "inspect",
      input: { value: "release" }
    })
    expect(pending.state).toEqual({ status: "pending" })
    expect(pending.transitions).toEqual([])

    const completed = actorCall([
      ...returned,
      {
        type: "ResponseReceived",
        id: "inspect-1.reply",
        method: "inspect",
        call: "inspect-1",
        status: "completed",
        output: "safe",
        from: "inspector:shared",
        at: 2
      } as Event
    ], {
      id: "inspect-1",
      target,
      method: "inspect",
      input: { value: "release" }
    })
    expect(completed.state).toEqual({ status: "completed", output: "safe" })
    expect(completed.transitions).toEqual([])
  })

  test("a response surviving without the sent marker suppresses redelivery", () => {
    const call = actorCall([{
      type: "ResponseReceived",
      id: "inspect-1.reply",
      method: "inspect",
      call: "inspect-1",
      status: "failed",
      error: "unavailable",
      from: "inspector:shared",
      at: 2
    } as Event], {
      id: "inspect-1",
      target,
      method: "inspect",
      input: { value: "release" }
    })

    expect(call.state).toEqual({ status: "failed", error: "unavailable" })
    expect(call.transitions).toEqual([])
  })

  test("an invalid completed output fails the future at the caller boundary", () => {
    const call = actorCall([{
      type: "ResponseReceived",
      id: "inspect-1.reply",
      method: "inspect",
      call: "inspect-1",
      status: "completed",
      output: 42,
      from: "inspector:shared",
      at: 2
    } as Event], {
      id: "inspect-1",
      target,
      method: "inspect",
      input: { value: "release" }
    })

    expect(call.state.status).toBe("failed")
    if (call.state.status === "failed") {
      expect(call.state.error).toContain("invalid inspect response")
    }
    expect(call.transitions).toEqual([])
  })

  test("a replayed call refuses method input drift", () => {
    const log: ReadonlyArray<Event> = [{
      type: "CallDispatched",
      id: "inspect-1",
      method: "inspect",
      target: "inspector:shared",
      input: { value: "release" },
      at: 1
    } as Event]

    expect(() => actorCall(log, {
      id: "inspect-1",
      target,
      method: "inspect",
      input: { value: "different" }
    })).toThrow("actor call \"inspect-1\" drifted: input does not match the recorded call")
  })
})
