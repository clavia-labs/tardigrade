import { expect, test } from "bun:test"
import fc from "fast-check"
import { Schema } from "effect"
import { eventAt, type Event } from "../event"
import { legacyActorMethod } from "../actor/method-compat"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import { invocationKey, type InvocationRef } from "./invocation"
import { actorCancellationProjection, cancellationDispositionOf, cancellationKeys, cancellationMethodFor, cancellationTransitionsOf } from "./cancellation"

const work = legacyActorMethod({
  input: Schema.String,
  output: Schema.String,
  event: ({ invocation, at }) => ({ type: "Started", invocation, at }),
  state: () => ({ status: "pending" }),
  cancellation: {
    state: (events, invocation) => {
      const owned = events.filter((event) => event.invocation !== undefined && invocationKey(event.invocation as InvocationRef) === invocationKey(invocation))
      if (!owned.some((event) => event.type === "Started")) return undefined
      return owned.some((event) => event.type === "Completed") ? "terminal" : "running"
    },
    event: (cancellation, at) => ({ type: "Cancelled", invocation: cancellation.invocation, at })
  }
})

const scenario = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }),
  epoch: fc.nat({ max: 20 }),
  count: fc.integer({ min: 1, max: 6 })
}).chain((value) => fc.shuffledSubarray(Array.from({ length: value.count }, (_, index) => index), {
  minLength: value.count, maxLength: value.count
}).map((order) => ({ ...value, order })))

test("completed parents retain exact child obligations through every completion order and replay", () => {
  fc.assert(fc.property(scenario, ({ id, epoch, count, order }) => {
    const parent = { method: "work", id, epoch }
    const child = { method: "work", id, epoch }
    const controlRef = { method: "$cancel", id: "request", epoch: 0 }
    const methods = { work }
    const cancel = cancellationMethodFor(methods)
    const target = (index: number) => ({ actor: "worker", instance: "main", thread: `child-${index}` })
    const response = (index: number): Event => ({
      type: "ResponseReceived", reference: { target: target(index), invocation: child },
      id: `reply-${index}`, from: `worker:main:child-${index}`, method: "work", call: id, epoch,
      status: "completed", output: "done", at: 10
    })
    const history: Event[] = [
      { type: "Started", invocation: parent, at: 1 },
      ...Array.from({ length: count }, (_, index): Event => ({
        type: "InvocationLinked", parent,
        owner: { type: "transition", ref: { seq: 1, component: "work", tag: `spawn-${index}` } },
        child: { invocation: child }, target: `worker:main:child-${index}`, at: 2
      })),
      { type: "Completed", invocation: parent, at: 3 },
      cancel.event({ invocation: controlRef, input: { invocation: parent }, at: 4 }),
      response(count)
    ]
    for (let completed = 0; completed <= count; completed++) {
      const expected = count - completed
      for (const log of [history, JSON.parse(JSON.stringify(history)) as Event[]]) {
        expect(cancellationDispositionOf(log, work, parent)).toBe(expected > 0 ? "requested" : "settled")
        const residuals = cancellationTransitionsOf(log, methods, [], cancellationKeys.keyOf)
        expect(residuals?.length ?? 0).toBe(expected)
        expect(residuals?.every((transition) => transition.kind === "effect") ?? true).toBe(true)
        const projection = actorCancellationProjection(methods, [], cancellationKeys.keyOf)!
        const state = log.map((event, index) => eventAt(event, index + 1)).reduce(projection.step, projection.initial())
        expect(projection.output(state).residuals?.map((transition) => transition.key))
          .toEqual(residuals?.map((transition) => transition.key))
        expect(replayProjection(cancel.projection, log).invocationState(controlRef))
          .toEqual(expected > 0 ? { status: "pending" } : { status: "completed", output: { cancelled: false } })
      }
      if (completed < count) history.push(response(order[completed]!))
    }
  }), { numRuns: 200 })
})
