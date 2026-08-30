import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import type { Event } from "../../log/event"
import { Router } from "../../communication/router"
import { EventLog, withWatermark } from "../../log"
import { intent, Self } from "../../reconciliation"
import type { Component } from "../component"
import { actorMethod } from "./definition"
import {
  CancellationRequested,
  cancellationKeys,
  cancellationRequestedOf,
  cancellationDispositionOf,
  cancellationRequestIdOf,
  cancellationTransitionsOf,
  cancellationMethodFor
} from "./cancellation"
import { alarmFired, earliestDeadlineOf, methodTimeoutReactor } from "./timeout"

const work = actorMethod({
  input: Schema.String,
  output: Schema.String,
  event: ({ invocation, at }) => ({ type: "WorkStarted", id: invocation.id, at }),
  state: () => ({ status: "pending" }),
  cancellation: {
    state: (events, { id }) => {
      if (!events.some((event) => event.type === "WorkStarted" && String((event as { readonly id?: unknown }).id) === id)) return undefined
      if (events.some((event) => event.type === "WorkCancelled" && String((event as { readonly id?: unknown }).id) === id)) return "cancelled"
      if (events.some((event) => event.type === "WorkCompleted" && String((event as { readonly id?: unknown }).id) === id)) return "terminal"
      return "running"
    },
    event: (cancellation, at) => ({ type: "WorkCancelled", id: cancellation.invocation.id, at })
  }
})

describe("actor cancellation", () => {
  test("the core event and key identify the target invocation independently of its requester", () => {
    const first = {
      type: "CancellationRequested",
      request: "x1",
      invocation: { method: "work", id: "w1", epoch: 0 },
      cause: "requested",
      at: 2
    } as Event
    const second = { ...first, request: "x2", at: 3 } as Event
    expect(cancellationRequestedOf(first)).toEqual({
      request: "x1",
      invocation: { method: "work", id: "w1", epoch: 0 },
      cause: "requested"
    })
    expect(cancellationKeys.keyOf(first)).toBe(cancellationKeys.keyOf(second))
    expect(() => Schema.decodeUnknownSync(CancellationRequested)({
      ...first,
      invocation: { method: "work", id: "w1", epoch: -1 }
    })).toThrow()
  })

  test("the standard cancel method delegates acceptance and outcome to the target method", () => {
    const cancel = cancellationMethodFor({ work })
    const head = { type: "WorkStarted", id: "w1", at: 1 } as Event
    const request = cancel.event({
      invocation: { method: "$cancel", id: "x1", epoch: 0 },
      input: { invocation: { method: "work", id: "w1", epoch: 0 } },
      at: 2
    })
    const cancellation = { method: "$cancel", id: "x1", epoch: 0 }
    expect(cancel.state([head, request], cancellation)).toEqual({ status: "pending" })
    expect(cancel.state([head, request, { type: "WorkCancelled", id: "w1", at: 3 }], cancellation))
      .toEqual({ status: "completed", output: { cancelled: true } })
    expect(cancel.state([request], cancellation)).toEqual({ status: "failed", error: 'invocation "w1" does not exist' })
  })

  test("a cancellation request reports the invocation's current disposition", () => {
    const invocation = { method: "work", id: "w1", epoch: 0 }
    const started = { type: "WorkStarted", id: "w1", at: 1 } as Event
    const requested = {
      type: "CancellationRequested",
      request: "x1",
      invocation,
      cause: "requested",
      at: 2
    } as Event

    expect(cancellationDispositionOf([], work, invocation)).toBeUndefined()
    expect(cancellationDispositionOf([started], work, invocation)).toBe("requestable")
    expect(cancellationDispositionOf([started, requested], work, invocation)).toBe("requested")
    expect(cancellationDispositionOf([
      started,
      requested,
      { type: "WorkCancelled", id: "w1", at: 3 } as Event
    ], work, invocation)).toBe("cancelled")
    expect(cancellationDispositionOf([
      started,
      { type: "WorkCompleted", id: "w1", at: 3 } as Event
    ], work, invocation)).toBe("settled")
    expect(cancellationRequestIdOf(invocation)).toBe('cancel:["work","w1",0]')
  })

  test("core projects component obligations before the method terminal", () => {
    const request = {
      type: "CancellationRequested",
      request: "x1",
      invocation: { method: "work", id: "w1", epoch: 0 },
      cause: "requested",
      reason: "operator stopped it",
      at: 2
    } as Event
    const cleanup = intent({
      key: "clean:w1",
      input: undefined,
      events: (_input, at) => [{ type: "WorkCleaned", id: "w1", at } as Event]
    })
    const component: Component<undefined> = {
      name: "worker",
      cancel: (events) => events.some((event) => event.type === "WorkCleaned") ? [] : [cleanup],
      derive: () => ({ view: undefined, transitions: [] })
    }
    const keyOf = (event: Event) => event.type === "WorkCleaned"
      ? `clean:${String((event as { readonly id?: unknown }).id)}`
      : event.type === "WorkCancelled"
        ? `cancelled:${String((event as { readonly id?: unknown }).id)}`
        : undefined
    const started = { type: "WorkStarted", id: "w1", at: 1 } as Event

    expect(cancellationTransitionsOf([started, request], { work }, [component], keyOf)).toEqual([cleanup])
    const terminal = cancellationTransitionsOf([
      started,
      request,
      { type: "WorkCleaned", id: "w1", at: 3 } as Event
    ], { work }, [component], keyOf)?.[0]
    expect(terminal).toMatchObject({ kind: "intent", key: "cancelled:w1" })
    if (terminal?.kind !== "intent") throw new Error("expected the cancellation terminal intent")
    expect(terminal.events(terminal.input, 4)).toEqual([{ type: "WorkCancelled", id: "w1", at: 4 }])
  })

  test("distinct invocation cancellations progress without a shared settlement barrier", () => {
    const invocation = (id: string) => ({ method: "work", id, epoch: 0 })
    const events: ReadonlyArray<Event> = [
      { type: "WorkStarted", id: "w1", at: 1 } as Event,
      { type: "WorkStarted", id: "w2", at: 2 } as Event,
      { type: "CancellationRequested", request: "x1", invocation: invocation("w1"), cause: "requested", at: 3 } as Event,
      { type: "CancellationRequested", request: "x2", invocation: invocation("w2"), cause: "requested", at: 4 } as Event,
      { type: "CancellationRequested", request: "x3", invocation: invocation("w1"), cause: "requested", at: 5 } as Event
    ]
    const component: Component<undefined> = {
      name: "worker",
      cancel: (_events, cancellation) => cancellation.invocation.id === "w1"
        ? [intent({
            key: "clean:w1",
            input: undefined,
            events: (_input, at) => [{ type: "WorkCleaned", id: "w1", at } as Event]
          })]
        : [],
      derive: () => ({ view: undefined, transitions: [] })
    }
    const keyOf = (event: Event) => event.type === "WorkCleaned"
      ? `clean:${String((event as { readonly id?: unknown }).id)}`
      : event.type === "WorkCancelled"
        ? `cancelled:${String((event as { readonly id?: unknown }).id)}`
        : undefined

    expect(cancellationTransitionsOf(events, { work }, [component], keyOf)
      ?.map((transition) => transition.key)).toEqual(["cancelled:w2", "clean:w1"])
    expect(cancellationTransitionsOf([
      ...events,
      { type: "WorkCancelled", id: "w2", at: 6 } as Event
    ], { work }, [component], keyOf)?.map((transition) => transition.key)).toEqual(["clean:w1"])
    expect(cancellationTransitionsOf([
      ...events,
      { type: "WorkCancelled", id: "w2", at: 6 } as Event,
      { type: "WorkCleaned", id: "w1", at: 7 } as Event
    ], { work }, [component], keyOf)?.map((transition) => transition.key)).toEqual(["cancelled:w1"])
  })

  test("a parent reaches and waits for every linked child cancellation", async () => {
    const request = {
      type: "CancellationRequested",
      request: "x1",
      invocation: { method: "work", id: "parent", epoch: 0 },
      cause: "requested",
      at: 2
    } as Event
    const link = {
      type: "InvocationLinked",
      parent: { method: "work", id: "parent", epoch: 0 },
      child: {
        invocation: { method: "work", id: "child", epoch: 0 },
        parent: { method: "work", id: "parent", epoch: 0 }
      },
      target: "worker:main:child",
      lineage: {
        parent: { actor: "worker", instance: "main", thread: "parent" },
        depth: 1
      },
      at: 1
    } as Event
    const started = { type: "WorkStarted", id: "parent", at: 1 } as Event
    const keyOf = (event: Event) => cancellationKeys.keyOf(event) ?? (event.type === "WorkCancelled"
      ? `cancelled:${String((event as { readonly id?: unknown }).id)}`
      : undefined)
    const cancelCall = "cancel/x1/work/child/0"

    const transition = cancellationTransitionsOf<never>([started, link, request], { work }, [], keyOf)?.[0]
    expect(transition?.key).toBe(`cxsend:${cancelCall}`)
    expect(transition?.kind).toBe("effect")
    if (transition?.kind !== "effect") throw new Error("expected a child cancellation effect")
    const sent: Array<{ readonly lineage?: unknown }> = []
    const dispatched = await Effect.runPromise(transition.act(transition.input, new AbortController().signal).pipe(Effect.provide(Layer.mergeAll(
      Layer.succeed(Self, { actor: "worker", instance: "main", thread: "parent" }),
      Layer.succeed(Router, { send: (envelope) => Effect.sync(() => void sent.push(envelope)) }),
      Layer.succeed(EventLog, withWatermark({ append: () => Effect.void, read: Effect.succeed([]) }))
    ))))
    expect(sent[0]?.lineage).toEqual({
      parent: { actor: "worker", instance: "main", thread: "parent" },
      depth: 1
    })
    expect(dispatched[0]).toMatchObject({
      type: "CancellationDispatched",
      request: cancelCall,
      timeoutMs: 30_000
    })
    expect(cancellationTransitionsOf([
      started,
      link,
      request,
      {
        type: "CancellationDispatched",
        request: cancelCall,
        invocation: { method: "work", id: "child", epoch: 0 },
        target: "worker:main:child",
        at: 3
      } as Event
    ], { work }, [], keyOf)?.map((transition) => transition.key)).toEqual([`cxwait:${cancelCall}`])
    expect(cancellationTransitionsOf([
      started,
      link,
      request,
      {
        type: "ResponseReceived",
        id: "child.cancelled",
        method: "$cancel",
        call: cancelCall,
        status: "completed",
        output: { cancelled: true },
        from: "worker:main:child",
        at: 3
      } as Event
    ], { work }, [], keyOf)?.map((transition) => transition.key)).toEqual(["cancelled:parent"])
  })

  test("an unreachable child is discharged at the configured cancellation deadline", async () => {
    const started = { type: "WorkStarted", id: "parent", at: 1 } as Event
    const request = {
      type: "CancellationRequested",
      request: "x1",
      invocation: { method: "work", id: "parent", epoch: 0 },
      cause: "requested",
      at: 2
    } as Event
    const link = {
      type: "InvocationLinked",
      parent: request.invocation,
      child: {
        invocation: { method: "work", id: "child", epoch: 0 },
        parent: request.invocation
      },
      target: "worker:main:child",
      at: 1
    } as Event
    const keyOf = (event: Event) => cancellationKeys.keyOf(event) ??
      (event.type === "WorkCancelled" ? `cancelled:${String((event as { readonly id?: unknown }).id)}` : undefined)
    const send = cancellationTransitionsOf<never>([started, link, request], { work }, [], keyOf, 7)?.[0]
    if (send?.kind !== "effect") throw new Error("expected a child cancellation effect")
    const dispatched = await Effect.runPromise(send.act(send.input, new AbortController().signal).pipe(Effect.provide(Layer.mergeAll(
      Layer.succeed(Self, { actor: "worker", instance: "main", thread: "parent" }),
      Layer.succeed(Router, { send: () => Effect.void }),
      Layer.succeed(EventLog, withWatermark({ append: () => Effect.void, read: Effect.succeed([]) }))
    ))))
    const dispatch = dispatched[0] as Event & { readonly deadlineAt: number; readonly at: number }
    expect(dispatch.deadlineAt - dispatch.at).toBe(7)
    expect(earliestDeadlineOf([...dispatched])).toBe(dispatch.deadlineAt)

    const beforeDeadline = [started, link, request, ...dispatched]
    expect(cancellationTransitionsOf(beforeDeadline, { work }, [], keyOf, 7)?.map((item) => item.key))
      .toEqual(["cxwait:cancel/x1/work/child/0"])
    const alarm = alarmFired({ scheduledFor: dispatch.deadlineAt, at: dispatch.deadlineAt })
    const timeout = methodTimeoutReactor([...beforeDeadline, alarm])[0]
    if (timeout?.kind !== "intent") throw new Error("expected the cancellation timeout intent")
    const timedOut = timeout.events(timeout.input, dispatch.deadlineAt)
    expect(timedOut[0]).toMatchObject({
      type: "CallTimedOut",
      call: "cancel/x1/work/child/0",
      method: "$cancel",
      timeoutMs: 7
    })
    expect(cancellationTransitionsOf(
      [...beforeDeadline, alarm, ...timedOut],
      { work },
      [],
      keyOf,
      7
    )?.map((item) => item.key)).toEqual(["cancelled:parent"])
  })

  test("core ignores unsupported and nonexistent cancellation targets", () => {
    const unsupported = {
      type: "CancellationRequested",
      request: "x1",
      invocation: { method: "other", id: "w1", epoch: 0 },
      cause: "requested",
      at: 1
    } as Event
    const missing = {
      type: "CancellationRequested",
      request: "x2",
      invocation: { method: "work", id: "missing", epoch: 0 },
      cause: "requested",
      at: 2
    } as Event
    expect(cancellationTransitionsOf([unsupported, missing], { work }, [], () => undefined)).toBeUndefined()
  })
})
