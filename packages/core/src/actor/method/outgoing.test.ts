import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import type { Event } from "../../log/event"
import { EventLog, withWatermark } from "../../log"
import { threadAddressOf } from "../../communication/endpoint"
import { Router } from "../../communication/router"
import { Self } from "../../reconciliation"
import { DEFAULT_ACTOR_METHOD_TIMEOUT_MS, actorMethod } from "./definition"
import { actorCall } from "./outgoing"
import { CANCELLATION_CONTROL_METHOD } from "./cancellation"

const inspect = actorMethod({
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.String,
  event: ({ invocation, input, at }): Event => ({ type: "InspectionRequested", id: invocation.id, value: input.value, at }),
  state: () => ({ status: "pending" })
})

const source = threadAddressOf("caller", "main", "root")
const target = {
  address: threadAddressOf("inspector", "main", "shared"),
  methods: { inspect }
}

const cancellableInspect = actorMethod({
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.String,
  event: ({ invocation, input, at }): Event => ({ type: "InspectionRequested", id: invocation.id, value: input.value, at }),
  state: () => ({ status: "pending" }),
  cancellation: {
    state: () => "running",
    event: (cancellation, at): Event => ({
      type: "InspectionCancelled",
      id: cancellation.invocation.id,
      request: cancellation.request,
      at
    })
  }
})

const cancellableTarget = {
  address: target.address,
  methods: { inspect: cancellableInspect }
}

describe("actorCall", () => {
  test("a cancellable method call exposes its paired durable cancellation", async () => {
    const sent: unknown[] = []
    const call = actorCall([], {
      id: "inspect-1",
      target: cancellableTarget,
      method: "inspect",
      input: { value: "release" }
    })
    const plannedCancellation = call.cancel({ id: "stop-1", reason: "operator stopped it" })
    const planning = plannedCancellation.transitions[0]!
    expect(planning.kind).toBe("intent")
    if (planning.kind !== "intent") return
    const planned = planning.events(planning.input, Date.now())
    const cancellation = actorCall(planned, {
      id: "inspect-1",
      target: cancellableTarget,
      method: "inspect",
      input: { value: "release" }
    }).cancel({ id: "stop-1", reason: "operator stopped it" })
    expect(cancellation).toMatchObject({
      id: "stop-1",
      method: CANCELLATION_CONTROL_METHOD,
      state: { status: "pending" }
    })
    const transition = cancellation.transitions[0]
    expect(transition?.kind).toBe("effect")
    if (transition?.kind !== "effect") return
    const returned = await Effect.runPromise(transition.act(
      transition.input,
      new AbortController().signal
    ).pipe(Effect.provide(Layer.mergeAll(
      Layer.succeed(Self, source),
      Layer.succeed(Router, { send: (envelope) => Effect.sync(() => void sent.push(envelope)) }),
      Layer.succeed(EventLog, withWatermark({ append: () => Effect.void, read: Effect.succeed([]) }))
    ))))

    expect(sent).toEqual([expect.objectContaining({
      call: { invocation: { method: CANCELLATION_CONTROL_METHOD, id: "stop-1", epoch: 0 }, deadlineAt: expect.any(Number) },
      event: expect.objectContaining({
        type: "CancellationRequested",
        request: "stop-1",
        invocation: { method: "inspect", id: "inspect-1", epoch: 0 },
        cause: "requested",
        reason: "operator stopped it"
      })
    })])
    expect(returned).toEqual([expect.objectContaining({
      type: "CallDispatched",
      id: "stop-1",
      method: CANCELLATION_CONTROL_METHOD
    })])
    expect("cancel" in actorCall([], {
      id: "inspect-2",
      target,
      method: "inspect",
      input: { value: "release" }
    })).toBe(false)
  })

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
    const planning = call.transitions[0]!
    expect(planning.kind).toBe("intent")
    if (planning.kind !== "intent") return
    const planned = planning.events(planning.input, Date.now())
    expect(planned).toEqual([expect.objectContaining({
      type: "CallPlanned",
      id: "inspect-1",
      method: "inspect"
    })])
    const plannedCall = actorCall(planned, {
      id: "inspect-1",
      target,
      method: "inspect",
      input: { value: "release" }
    })
    const transition = plannedCall.transitions[0]!
    expect(transition.kind).toBe("effect")
    if (transition.kind !== "effect") return

    const returned = await Effect.runPromise(transition.act(transition.input, new AbortController().signal).pipe(Effect.provide(Layer.mergeAll(
      Layer.succeed(Self, source),
      Layer.succeed(Router, { send: (envelope) => Effect.sync(() => void sent.push(envelope)) }),
      Layer.succeed(EventLog, withWatermark({ append: () => Effect.void, read: Effect.succeed([]) }))
    ))))

    expect(sent).toEqual([expect.objectContaining({
      link: { source, target: target.address },
      call: {
        invocation: { method: "inspect", id: "inspect-1", epoch: 0 },
        deadlineAt: expect.any(Number)
      },
      event: expect.objectContaining({ type: "InspectionRequested", id: "inspect-1", value: "release" })
    })])
    expect(returned).toEqual([expect.objectContaining({
      type: "CallDispatched",
      id: "inspect-1",
      method: "inspect",
      target: "inspector:main:shared",
      input: { value: "release" }
    })])
    const dispatch = returned[0] as unknown as { readonly at: number; readonly deadlineAt: number; readonly timeoutMs: number }
    const plan = planned[0] as unknown as { readonly at: number }
    expect(dispatch.timeoutMs).toBe(DEFAULT_ACTOR_METHOD_TIMEOUT_MS)
    expect(dispatch.deadlineAt - plan.at).toBe(DEFAULT_ACTOR_METHOD_TIMEOUT_MS)

    const log = [...planned, ...returned]
    const pending = actorCall(log, {
      id: "inspect-1",
      target,
      method: "inspect",
      input: { value: "release" }
    })
    expect(pending.state).toEqual({ status: "pending" })
    expect(pending.transitions).toEqual([])

    const completed = actorCall([
      ...log,
      {
        type: "ResponseReceived",
        id: "inspect-1.reply",
        method: "inspect",
        call: "inspect-1",
        status: "completed",
        output: "safe",
        from: "inspector:main:shared",
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
      from: "inspector:main:shared",
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

  test("a recorded timeout fails the durable future", () => {
    const call = actorCall([{
      type: "CallTimedOut",
      call: "inspect-1",
      method: "inspect",
      target: "inspector:main:shared",
      timeoutMs: 25,
      deadlineAt: 26,
      at: 27
    }], {
      id: "inspect-1",
      target,
      method: "inspect",
      input: { value: "release" }
    })
    expect(call.state).toEqual({ status: "failed", error: "inspect timed out after 25ms" })
    expect(call.transitions).toEqual([])
  })

  test("a caller may shorten a method deadline and cannot extend it", () => {
    expect(actorCall([], {
      id: "inspect-1",
      target,
      method: "inspect",
      input: { value: "release" },
      timeoutMs: 25
    }).transitions).toHaveLength(1)
    expect(() => actorCall([], {
      id: "inspect-1",
      target,
      method: "inspect",
      input: { value: "release" },
      timeoutMs: DEFAULT_ACTOR_METHOD_TIMEOUT_MS + 1
    })).toThrow("cannot exceed")
  })

  test("a child inherits the tighter parent deadline before publication", () => {
    const parent = {
      invocation: { method: "message", id: "m1", epoch: 2 },
      deadlineAt: 250
    } as const
    const call = actorCall([], {
      id: "inspect-1",
      target,
      method: "inspect",
      input: { value: "release" },
      context: parent,
      timeoutMs: 100
    })
    const planning = call.transitions[0]!
    expect(planning.kind).toBe("intent")
    if (planning.kind !== "intent") return
    const events = planning.events(planning.input, 200)
    expect(events).toEqual([
      expect.objectContaining({
        type: "CallPlanned",
        context: {
          invocation: { method: "inspect", id: "inspect-1", epoch: 0 },
          parent: parent.invocation,
          deadlineAt: 250
        }
      }),
      expect.objectContaining({
        type: "InvocationLinked",
        parent: parent.invocation,
        child: expect.objectContaining({ deadlineAt: 250 })
      })
    ])
  })

  test("an expired inherited deadline prevents external publication", async () => {
    const sent: unknown[] = []
    const parent = {
      invocation: { method: "message", id: "m1", epoch: 0 },
      deadlineAt: 1
    } as const
    const first = actorCall([], {
      id: "inspect-1",
      target,
      method: "inspect",
      input: { value: "release" },
      context: parent
    })
    const planning = first.transitions[0]!
    expect(planning.kind).toBe("intent")
    if (planning.kind !== "intent") return
    const planned = planning.events(planning.input, 0)
    const second = actorCall(planned, {
      id: "inspect-1",
      target,
      method: "inspect",
      input: { value: "release" },
      context: parent
    })
    const dispatch = second.transitions[0]!
    expect(dispatch.kind).toBe("effect")
    if (dispatch.kind !== "effect") return
    const returned = await Effect.runPromise(dispatch.act(
      dispatch.input,
      new AbortController().signal
    ).pipe(Effect.provide(Layer.mergeAll(
      Layer.succeed(Self, source),
      Layer.succeed(Router, { send: (envelope) => Effect.sync(() => void sent.push(envelope)) }),
      Layer.succeed(EventLog, withWatermark({ append: () => Effect.void, read: Effect.succeed([]) }))
    ))))
    expect(sent).toEqual([])
    expect(returned.map((event) => event.type)).toEqual(["CallSkipped", "CallTimedOut"])
  })

  test("an invalid completed output fails the future at the caller boundary", () => {
    const call = actorCall([{
      type: "ResponseReceived",
      id: "inspect-1.reply",
      method: "inspect",
      call: "inspect-1",
      status: "completed",
      output: 42,
      from: "inspector:main:shared",
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
      target: "inspector:main:shared",
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
