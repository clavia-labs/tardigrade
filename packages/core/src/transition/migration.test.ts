import { expect, test } from "bun:test"
import { Effect } from "effect"
import { component, deriveComponent, transitionProjectionOf, type TransitionContext } from "../component"
import { eventAt, type Event } from "../event"
import { bindTransitionContext, transitionKeyOf } from "./transition"
import { actorFromProjections, enabled, settleActor } from "../runtime"
import { EventLog, withWatermark } from "../log"

const child = component({
  name: "child",
  initial: () => undefined as TransitionContext | undefined,
  step: (state, event, context) => event.type === "Requested" ? context : state,
  output: (context) => ({ view: undefined, transitions: context === undefined ? [] : [context.intent("answer", { type: "Answered" })] })
})

test("a wrapper forwards only its declared children's scoped transitions", () => {
  const wrapper = (children: ReadonlyArray<typeof child>) => component({
    name: "wrapper", children,
    initial: child.machine.initial, step: child.machine.step, output: child.machine.output
  })
  const log = [{ type: "Requested" }]
  expect(deriveComponent(wrapper([child]), log).transitions.map((transition) => transition.key))
    .toEqual(deriveComponent(child, log).transitions.map((transition) => transition.key))
  expect(() => deriveComponent(wrapper([]), log)).toThrow("belongs to component")
  expect(() => wrapper([child, child])).toThrow("duplicate component identity")
})

test("a batch preserves domain facts and one completion across cold replay", async () => {
  const invocation = { method: "run", id: "call", epoch: 2 }
  let calls = 0
  let events: ReadonlyArray<Event> = [{ type: "Requested", call: { invocation } }]
  const source = component({
    name: "source",
    initial: () => undefined as TransitionContext | undefined,
    step: (state, event, context) => event.type === "Requested" ? context : state,
    output: (context) => ({ view: undefined, transitions: context === undefined ? [] : [context.effect("answer", {
      input: undefined,
      act: () => Effect.sync(() => { calls++; return [{ type: "Text", text: "working" }, { type: "Answered", value: 42 }] })
    })] })
  })
  const actor = actorFromProjections({ transitions: [transitionProjectionOf(source)], keyOf: () => undefined })
  const log = withWatermark({
    read: Effect.sync(() => events),
    append: (batch: ReadonlyArray<Event>) => Effect.sync(() => {
      const keys = new Set(events.map(transitionKeyOf).filter((key) => key !== undefined))
      events = [...events, ...batch.filter((event) => {
        const key = transitionKeyOf(event)
        if (key === undefined) return true
        if (keys.has(key)) return false
        keys.add(key)
        return true
      })]
    })
  })
  await Effect.runPromise(settleActor(actor).pipe(Effect.provideService(EventLog, log)))
  expect(events.map((event) => event.type)).toEqual(["Requested", "Text", "Answered"])
  expect(events.slice(1).map((event) => event.invocationRef)).toEqual([invocation, invocation])
  expect(events.slice(1).filter((event) => transitionKeyOf(event) !== undefined)).toHaveLength(1)
  events = JSON.parse(JSON.stringify(events)) as ReadonlyArray<Event>
  await Effect.runPromise(settleActor(actor).pipe(Effect.provideService(EventLog, log)))
  expect(calls).toBe(1)
  expect(events).toHaveLength(3)
})

test("concurrent cancellation cleanup retains duplicate identity checks", () => {
  const cleanup = bindTransitionContext(eventAt({ type: "Requested" }, 1), "cleanup").effect("close", {
    input: undefined, act: () => Effect.succeed({ type: "Closed" })
  })
  const actor = actorFromProjections({ transitions: [], keyOf: () => undefined,
    legacy: { cancellationResiduals: () => [cleanup, cleanup] } })
  expect(() => enabled(actor, [{ type: "Requested" }])).toThrow("duplicate transition tag")
})
