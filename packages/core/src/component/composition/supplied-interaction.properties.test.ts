import { expect, test } from "bun:test"
import fc from "fast-check"
import { Effect, Layer } from "effect"
import { eventAt, type Event } from "../../event"
import { EventLog, withWatermark } from "../../log"
import { replayState } from "../../projection/projection"
import { actorFromProjections, settleActor } from "../../runtime"
import { interactionScope, type InteractionRequest } from "../../transition/interaction"
import type { TransitionContext } from "../../transition/transition"
import { component } from "../machine"
import { machineOf, transitionProjectionOf } from "../runtime"

type Pending = { readonly value: number; readonly tag: string; readonly context: TransitionContext }
const sender = (send: (value: number) => InteractionRequest) => component({
  name: "source",
  initial: (): ReadonlyArray<Pending> => [],
  step: (state, event, context) => event.type === "Trigger"
    ? [...state, ...(event.values as number[]).map((value, index) => ({ value, tag: `item:${index}`, context }))]
    : state.filter(item => !item.context.matches(item.tag, event) &&
      !(event.type === "Withdraw" && event.key === item.context.intent(item.tag, []).key)),
  output: state => ({
    view: state.map(item => ({ key: item.context.intent(item.tag, []).key, value: item.value })) as ReadonlyArray<{ readonly key: string; readonly value: number }>,
    transitions: state.map(item => item.context.interaction(item.tag, send(item.value)))
  })
})

const assembled = (depth: number) => {
  const scope = interactionScope("receiver")
  const send = scope.define<number>((value, { id, at }) => ({ type: "Received", id, value, at }))
  let child = sender(send)
  for (let index = 0; index < depth; index++) {
    child = component({ name: `wrapper-${index}`, children: child,
      initial: () => undefined, step: () => undefined, output: (_state, bound) => bound.output() })
  }
  return component({
    name: "receiver", input: { send }, children: child,
    initial: (): ReadonlyArray<{ readonly key: string; readonly value: number }> => [],
    step: (state, event) => event.type === "Received" ? [...state, { key: String(event.id), value: Number(event.value) }] : state,
    output: (received, bound) => ({ ...bound.output(), view: { pending: bound.output().view, received } })
  })
}

const command = fc.oneof(
  fc.record({ kind: fc.constant("trigger" as const), values: fc.array(fc.integer(), { minLength: 1, maxLength: 3 }) }),
  fc.record({ kind: fc.constant("withdraw" as const), choice: fc.nat(20) }),
  fc.record({ kind: fc.constantFrom("observe", "noise", "restart", "settle") })
)

test("supplied interactions refine source occurrences across fanout, withdrawal, wrapping, and recovery", async () => {
  await fc.assert(fc.asyncProperty(fc.array(command, { maxLength: 35 }), fc.integer({ min: 0, max: 3 }), async (commands, depth) => {
    let root = assembled(depth)
    let machine = machineOf(root)
    let state = machine.initial()
    const events: Event[] = []
    const pending = new Map<string, number>()
    const received = new Map<string, number>()
    const layer = Layer.succeed(EventLog, withWatermark({
      read: Effect.sync(() => events.slice()),
      append: batch => Effect.sync(() => { events.push(...batch) })
    }))
    const append = (event: Event) => { events.push(event); state = machine.step(state, eventAt(event, events.length)) }
    const sorted = (entries: ReadonlyArray<{ readonly key: string; readonly value: number }>) => [...entries].sort((a, b) => a.key.localeCompare(b.key))
    const expected = (entries: Map<string, number>) => sorted([...entries].map(([key, value]) => ({ key, value })))
    for (const action of commands) {
      switch (action.kind) {
        case "trigger":
          append({ type: "Trigger", values: action.values })
          action.values.forEach((value, index) => pending.set(JSON.stringify([events.length, "source", `item:${index}`]), value))
          break
        case "withdraw": {
          const keys = [...pending.keys()]
          if (keys.length > 0) {
            const key = keys[action.choice % keys.length]!
            append({ type: "Withdraw", key })
            pending.delete(key)
          }
          break
        }
        case "noise": append({ type: "Noise" }); break
        case "restart":
          root = assembled(depth)
          machine = machineOf(root)
          state = replayState(machine, events)
          break
        case "settle": {
          const start = events.length
          const runtime = actorFromProjections({ transitions: [transitionProjectionOf(root)], keyOf: () => undefined })
          await Effect.runPromise(settleActor(runtime).pipe(Effect.provide(layer)))
          for (let index = start; index < events.length; index++) state = machine.step(state, eventAt(events[index]!, index + 1))
          for (const [key, value] of pending) received.set(key, value)
          pending.clear()
          break
        }
        case "observe": {
          const before = machine.output(state)
          const length = events.length
          for (const work of before.transitions) {
            if (work.kind !== "intent") throw new Error("expected interaction intent")
            expect(work.events(work.input, 10)).toMatchObject([{ type: "Received", id: work.key, value: pending.get(work.key), at: 10 }])
          }
          expect(machine.output(state)).toBe(before)
          expect(events).toHaveLength(length)
        }
      }
      const output = machine.output(state)
      expect(sorted(output.view.pending)).toEqual(expected(pending))
      expect(sorted(output.view.received)).toEqual(expected(received))
      expect(output.transitions.map(work => work.key).sort()).toEqual([...pending.keys()].sort())
      expect(machine.output(replayState(machine, events)).view).toEqual(output.view)
      expect(events.filter(event => event.type === "Received")).toHaveLength(received.size)
    }
  }), { numRuns: 200 })
})

test("describing and binding requests defer the event constructor until materialization", () => {
  fc.assert(fc.property(fc.integer(), fc.nat(15), (value, observations) => {
    let built = 0
    const scope = interactionScope("receiver")
    const send = scope.define<number>((input, { id }) => { built++; return { type: "Received", id, value: input } })
    const root = component({ name: "receiver", input: { send }, children: sender(send),
      initial: () => undefined, step: () => undefined, output: (_state, child) => child.output() })
    send(value)
    const machine = machineOf(root)
    const log = [{ type: "Trigger", values: [value] }]
    for (let index = 0; index <= observations; index++) machine.output(replayState(machine, log))
    expect(built).toBe(0)
    const work = machine.output(replayState(machine, log)).transitions[0]!
    if (work.kind !== "intent") throw new Error("expected intent")
    work.events(work.input, 0)
    expect(built).toBe(1)
  }))
})

test("a missing or same-named foreign supplier cannot authorize a captured capability", () => {
  fc.assert(fc.property(fc.integer(), fc.boolean(), (value, missing) => {
    const scope = interactionScope("receiver")
    const send = scope.define<number>((input, { id }) => ({ type: "Received", id, value: input }))
    const root = component({ name: "foreign", input: missing ? {} : { send: interactionScope("receiver").define<number>(value => ({ type: "Foreign", value })) }, children: sender(send),
      initial: () => undefined, step: () => undefined, output: (_state, child) => child.output() })
    const machine = machineOf(root)
    expect(() => machine.output(replayState(machine, [{ type: "Trigger", values: [value] }]))).toThrow("not supplied")
  }))
})

test("a parent can bind its child's stable input without evaluating the child's output", () => {
  fc.assert(fc.property(fc.integer(), value => {
    const scope = interactionScope("counter")
    let outputs = 0
    const receiver = component({
      name: "counter", input: { add: scope.define<number>((amount, { id }) => ({ type: "Added", amount, id })) },
      initial: () => 0,
      step: (state, event) => event.type === "Added" ? state + Number(event.amount) : state,
      output: state => { outputs++; return { view: state, transitions: [], interactions: { read: () => state } } }
    })
    const request = receiver.input.add(value)
    expect(outputs).toBe(0)
    const parent = component({
      name: "parent", children: receiver,
      initial: (): TransitionContext | undefined => undefined,
      step: (state, event, context) => event.type === "Trigger" ? context : state?.matches("add", event) ? undefined : state,
      output: (state, child) => ({ view: child.output().view,
        transitions: state === undefined ? [] : [state.interaction("add", request)] })
    })
    const machine = machineOf(parent)
    const state = replayState(machine, [{ type: "Trigger" }])
    const work = machine.output(state).transitions[0]!
    if (work.kind !== "intent") throw new Error("expected input intent")
    const events = work.events(work.input, 1)
    const settled = machine.output(replayState(machine, [{ type: "Trigger" }, ...events]))
    expect(settled.view).toBe(value)
    expect(settled.transitions).toEqual([])
    expect(machineOf(receiver).output(replayState(machineOf(receiver), events)).interactions?.read()).toBe(value)
  }))
})

test("a sibling's public input is not implicitly supplied to another sibling", () => {
  fc.assert(fc.property(fc.integer(), value => {
    const scope = interactionScope("left")
    const send = scope.define<number>(value => ({ type: "Received", value }))
    const left = component({ name: "left", input: { send },
      initial: () => undefined, step: () => undefined, output: () => ({ view: undefined, transitions: [] }) })
    const right = sender(left.input.send)
    const parent = component({ name: "parent", children: [left, right],
      initial: () => undefined, step: () => undefined,
      output: (_state, children) => ({ view: undefined, transitions: children.flatMap(child => child.output().transitions) }) })
    expect(() => replayState(machineOf(parent), [{ type: "Trigger", values: [value] }])).toThrow("not supplied")
  }))
})
