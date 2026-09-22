import { machineOf } from "../runtime"
import { expect, expectTypeOf, test } from "bun:test"
import { Effect } from "effect"
import { eventAt } from "../../event"
import { replayState } from "../../projection/projection"
import { annotateTransition, bindTransitionContext, executionOnly, validateTransitions, type TransitionContext } from "../../transition/transition"
import { component } from "../machine"
import { withResponse } from "../output"
import { composeComponents } from "./siblings"
import type { ComponentResult } from "../component"

const worker = (name: string) => component({
  name,
  initial: (): TransitionContext | undefined => undefined,
  step: (state, event, context) => event.type === "Requested" ? context : event.type === "Finished" ? undefined : state,
  output: (state) => ({
    view: { pending: state !== undefined },
    transitions: state === undefined ? [] : [withResponse(state.effect("execute", {
      input: undefined, act: () => Effect.die("settlement must not execute the work")
    }), (result: { readonly error: string }) => state.intent("finish", { type: "Finished", result }))]
  }),
})

test("settlement is typed, pure, and stable across decoration and replay", () => {
  const child = worker("worker")
  const state = replayState(machineOf(child), [{ type: "Requested" }])
  const output = machineOf(child).output(state)
  const transition = output.transitions[0]!
  const decorated = annotateTransition(transition, Symbol("label"), "decorated")
  const result = { error: "refused" }
  expectTypeOf<ComponentResult<typeof child>>().toEqualTypeOf<{ readonly error: string }>()
  const completion = decorated.respond!(result)
  expect(transition.respond!(result).key).toBe(completion.key)
  expect(machineOf(child).output(state)).toBe(output)
  expect(machineOf(child).output(state).view).toEqual({ pending: true })
  const replayed = replayState(machineOf(child), [{ type: "Requested" }])
  expect(machineOf(child).output(replayed).transitions[0]!.respond!(result).key).toBe(completion.key)
  const events = completion.events(completion.input, 0)
  expect(events).toMatchObject([{ type: "Finished", result }])
  const settled = machineOf(child).step(state, eventAt(events[0]!, 2))
  expect(machineOf(child).output(settled).view).toEqual({ pending: false })
  expect(machineOf(child).output(settled).transitions).toEqual([])
  expect(transition.respond!(result).key).toBe(completion.key)
  const foreign = bindTransitionContext(eventAt({ type: "Requested" }, 1), "foreign").intent("execute", { type: "Finished" })
  expect(foreign).not.toHaveProperty("respond")
})

test("composition forwards settlement only for proposals selected at its boundary", () => {
  const first = worker("first")
  const second = worker("second")
  const algebra = { empty: { pending: false }, combine: (left: { pending: boolean }, right: { pending: boolean }) => ({ pending: left.pending || right.pending }) }
  const plain = component({ name: "plain", initial: () => 0, step: (state) => state,  output: () => ({ view: { pending: false }, transitions: [] }) })
  const combined = composeComponents("combined", algebra, [first, second, plain])
  expectTypeOf<ComponentResult<typeof combined>>().toEqualTypeOf<{ readonly error: string }>()
  const snapshot = replayState(machineOf(combined), [{ type: "Requested" }])
  for (const transition of machineOf(combined).output(snapshot).transitions) {
    const completion = transition.respond!({ error: "denied" })
    expect(completion.events(completion.input, 0)[0]).toMatchObject({ transitionRef: { component: transition.key.includes("first") ? "first" : "second" } })
  }
  const blocked = composeComponents("blocked", algebra, [combined], { reconcile: () => [] })
  const blockedState = replayState(machineOf(blocked), [{ type: "Requested" }])
  expect(machineOf(blocked).output(blockedState).transitions).toEqual([])
})

test("settlement result types do not widen across heterogeneous siblings", () => {
  const numeric = component({
    name: "numeric", initial: (): TransitionContext | undefined => undefined,
    step: (_state, _event, context) => context,
    output: (state) => ({ view: { pending: false }, transitions: state === undefined ? [] : [
      withResponse(state.intent("work", { type: "Worked" }), (result: number) => state.intent("finish", { type: "Finished", result }))
    ] }),
  })
  const combined = composeComponents("mixed", { empty: { pending: false }, combine: (a: { pending: boolean }, b: { pending: boolean }) => ({ pending: a.pending || b.pending }) }, [worker("worker"), numeric])
  expectTypeOf<ComponentResult<typeof combined>>().toEqualTypeOf<{ readonly error: string } & number>()
})

test("completion remains owned by the producer of the proposed work", () => {
  const event = eventAt({ type: "Requested" }, 1)
  const owner = bindTransitionContext(event, "owner")
  const foreign = bindTransitionContext(event, "foreign")
  const proposal = withResponse(owner.intent("work", { type: "Worked" }),
    () => foreign.intent("finish", { type: "Finished" }))
  expect(() => proposal.respond(undefined)).toThrow('transition belongs to component "foreign"')
})

test("an adapter can forward execution without exposing an incompatible completion", () => {
  const owner = bindTransitionContext(eventAt({ type: "Requested" }, 1), "owner")
  const label = Symbol("label")
  const proposal = annotateTransition(withResponse(owner.intent("work", { type: "Worked" }),
    (result: number) => owner.intent("finish", { type: "Finished", result })), label, "work")
  const execution = executionOnly(proposal)
  expect(execution).not.toHaveProperty("respond")
  expect(execution.key).toBe(proposal.key)
  expect(execution).toMatchObject({ events: proposal.events })
  expect(Reflect.get(execution, label)).toBe("work")
  expect(() => validateTransitions([execution], "owner")).not.toThrow()
  expect(() => validateTransitions([execution], "foreign")).toThrow()
  expect(executionOnly(execution)).toBe(execution)
})
