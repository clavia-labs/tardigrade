import { machineOf } from "../runtime"
import { expect, expectTypeOf, test } from "bun:test"
import { Effect } from "effect"
import { eventAt } from "../../event"
import { replayState } from "../../projection/projection"
import { bindTransitionContext, type TransitionContext } from "../../transition/transition"
import { component } from "../machine"
import { withResponse } from "../output"
import { bindChild, type ChildOf } from "./children"

const worker = () => component({
  name: "worker",
  initial: () => ({ count: 0, pending: undefined as TransitionContext | undefined }),
  step: (state, event, context) => ({
    count: state.count + 1,
    pending: event.type === "Requested" ? context : event.type === "Finished" ? undefined : state.pending
  }),
  output: (state) => ({
    view: { count: state.count }, transitions: state.pending === undefined ? [] : [
      withResponse(state.pending.effect("run", { input: undefined, act: () => Effect.die("must not execute") }), (result: {
        readonly error: string
      }) => state.pending!.intent("finish", { type: "Finished", result }))
    ], interactions: state.pending === undefined ? {} : {
      cancel: () => [state.pending!.intent("cancel", { type: "Finished" })]
    }
  }),

})

test("view access and previews share their snapshot's complete readout", () => {
  let readouts = 0
  const child = component({
    name: "readout",
    initial: () => 0,
    step: (state) => state + 1,
    output: (state) => {
      readouts++
      return { view: { count: state }, transitions: [bindTransitionContext(eventAt({ type: "Requested" }, 1), "readout").intent("increment", { type: "Incremented" })] }
    }
  })
  const machine = machineOf(child)
  const handle = bindChild(machine, machine.initial())
  const output = handle.output()
  expect(handle.output().view).toBe(output.view)
  expect(handle.output()).toBe(output)
  expect(readouts).toBe(1)
  const proposal = handle.output().transitions[0]!
  if (proposal.kind !== "intent") throw new Error("expected intent")
  const preview = handle.admission().preview(proposal)
  expect(preview.output().view).toEqual({ count: 1 })
  expect(preview.output().view).toBe(preview.output().view)
  expect(preview.output()).not.toHaveProperty("transitions")
  expect(preview).not.toHaveProperty("methods")
  expect(handle.output()).toBe(output)
  expect(handle.output().view).toEqual({ count: 0 })
  expect(readouts).toBe(2)
})

test("wrapper handles retain their snapshots and advance children before parent evaluation", () => {
  const child = worker()
  const handles: Array<ChildOf<typeof child>> = []
  const wrapped = component({
    children: child,
    name: "parent",
    initial: (bound) => { handles.push(bound); return 0 },
    step: (state, _event, _context, current, previous) => {
      expect(current.output().view.count).toBe(previous.output().view.count + 1)
      handles.push(current)
      return state + 1
    },
    output: (state, bound) => ({ ...bound.output(), view: { parent: state, child: bound.output().view.count } })
  })
  const snapshot = replayState(machineOf(wrapped), [{ type: "Requested" }, { type: "Other" }])
  expect(machineOf(wrapped).output(snapshot).view).toEqual({ parent: 2, child: 2 })
  expect(handles.map((handle) => handle.output().view.count)).toEqual([0, 1, 2])
  expect(Object.keys(handles[1]!).sort()).toEqual(["admission", "output"])
  expectTypeOf<Parameters<NonNullable<ReturnType<ChildOf<typeof child>["output"]>["transitions"][number]["respond"]>>[0]>().toEqualTypeOf<{ readonly error: string }>()
  const proposal = handles[1]!.output().transitions[0]!
  const completion = machineOf(wrapped).output(snapshot).transitions[0]!.respond!({ error: "denied" })
  const settled = machineOf(wrapped).step(snapshot, eventAt(completion.events(completion.input, 0)[0]!, 3))
  expect(machineOf(wrapped).output(settled).transitions).toEqual([])
  expect(machineOf(wrapped).output(settled).interactions?.cancel).toBeUndefined()
  expect(handles[0]!.output().interactions?.cancel).toBeUndefined()
  expect(proposal.respond!({ error: "denied" }).key).toBe(completion.key)
  expect(machineOf(wrapped).output(snapshot).interactions?.cancel?.({ request: "stop", invocation: { method: "run", id: "1", epoch: 0 }, cause: "requested" })).toHaveLength(1)
})

test("admission reserves only offered intents without changing the child", () => {
  const context = bindTransitionContext(eventAt({ type: "Requested" }, 1), "counter")
  const child = component({
    name: "counter", initial: () => 0, step: (state) => state + 1,
    output: (state) => ({ view: state, transitions: [
      context.intent("first", { type: "Incremented" }),
      context.intent("second", { type: "Incremented" }),
      context.effect("external", { input: undefined, act: () => Effect.die("must not run") })
    ] })
  })
  const machine = machineOf(child)
  const state = machine.initial()
  const handle = bindChild(machine, state)
  const [first, second, effect] = handle.output().transitions
  if (first?.kind !== "intent" || second?.kind !== "intent") throw new Error("expected intents")
  const plan = handle.admission()
  const reserved = plan.preview(first)
  expect(reserved.output().view).toBe(1)
  expect(reserved.preview(second).output().view).toBe(2)
  expect(plan.output().view).toBe(0)
  expect(handle.output().view).toBe(0)
  expect(reserved.output()).not.toHaveProperty("transitions")
  expect(reserved).not.toHaveProperty("methods")
  expectTypeOf<keyof typeof reserved>().toEqualTypeOf<"output" | "preview">()
  expect(() => reserved.preview(first)).toThrow("twice")
  expect(() => plan.preview(context.intent("foreign", { type: "Incremented" }))).toThrow("this child output")
  const next = bindChild(machine, machine.step(state, eventAt({ type: "Other" }, 2)))
  expect(() => next.admission().preview(first)).toThrow("this child output")
  // @ts-expect-error Effects cannot be previewed as known events.
  expect(() => plan.preview(effect)).toThrow("intent")
  // @ts-expect-error Admission cannot deliver arbitrary events.
  expect(() => plan.preview([{ type: "Incremented" }])).toThrow("intent")
})

test("a wrapper exposes no completion for work excluded from its output", () => {
  const child = worker()
  const childMachine = machineOf(child)
  let proposal: ReturnType<typeof childMachine.output>["transitions"][number] | undefined
  const wrapped = component({
    children: child,
    name: "blocked", initial: () => undefined, step: () => undefined,
    output: (_state, bound) => { proposal = bound.output().transitions[0]; return { view: 0, transitions: [] } },
  })
  const state = replayState(machineOf(wrapped), [{ type: "Requested" }])
  expect(proposal).toBeDefined()
  expect(machineOf(wrapped).output(state).transitions).toEqual([])
})

test("multiple children retain distinct view types", () => {
  const first = worker()
  const second = component({
    name: "label", initial: () => "ready", step: (_state, event) => event.type,
    output: (state) => ({ view: state, transitions: [] }),

  })
  const wrapped = component({
    children: [first, second] as const,
    name: "siblings", initial: () => undefined, step: () => undefined,
    output: (_state, [left, right]) => {
      expectTypeOf(left.output().view).toEqualTypeOf<{ readonly count: number }>()
      expectTypeOf(right.output().view).toEqualTypeOf<string>()
      expectTypeOf(right.output().view).toEqualTypeOf<string>()
      return { ...left.output(), view: [left.output().view.count, right.output().view] as const }
    }
  })
  const state = replayState(machineOf(wrapped), [{ type: "Requested" }])
  expect(machineOf(wrapped).output(state).view).toEqual([1, "Requested"])
})
