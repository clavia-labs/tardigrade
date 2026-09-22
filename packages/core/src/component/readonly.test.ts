import { expect, test } from "bun:test"
import { component } from "./machine"
import { machineOf } from "./runtime"
import { Equal, HashMap } from "effect"
import { eventAt } from "../event"
import { bindTransitionContext } from "../transition/transition"
import { bindChild } from "./composition/children"

// rejectMutations typechecks forbidden writes without executing them.
const rejectMutations = () => component({
  name: "readonly",
  initial: () => ({ count: 0 }),
  step: (state) => {
    // @ts-expect-error State input belongs to the prior snapshot.
    state.count += 1
    return { count: state.count + 1 }
  },
  output: (state) => {
    // @ts-expect-error Output queries cannot modify state fields.
    state.count = 4
    return {
      view: { count: state.count }, transitions: [], interactions: {
        cancel: () => {
          // @ts-expect-error Cancellation derives work from a readonly snapshot.
          state.count = 6
          return []
        }
      }
    }
  },

})

const rejectViewMutation = () => component({
  name: "parent", children: rejectMutations(), initial: () => undefined, step: () => undefined,
  output: (_state, child) => {
    // @ts-expect-error Public views are readonly.
    child.output().view.count = 7
    // @ts-expect-error The output accessor preserves view readonlyness.
    child.output().view.count = 7
    // @ts-expect-error Preview views are readonly.
    child.admission().output().view.count = 8
    return child.output()
  }
})

test("readonly inputs allow constructing fresh next state", () => {
  expect(typeof rejectViewMutation).toBe("function")
  const counter = component({
    name: "counter", initial: () => ({ count: 0 }), step: (state) => ({ count: state.count + 1 }),
    output: (state) => ({ view: { count: state.count }, transitions: [] })
  })
  const machine = machineOf(counter)
  const initial = machine.initial()
  const next = machine.step(initial, { type: "Incremented" })
  expect(machine.output(initial).view).toEqual({ count: 0 })
  expect(machine.output(next).view).toEqual({ count: 1 })
})

test("persistent collection updates preserve snapshots across previews and branches", () => {
  const counter = component({
    name: "counts",
    initial: () => ({ counts: HashMap.make(["total", 0]) }),
    step: (state) => ({
      counts: HashMap.mutate(state.counts, (draft) => {
        HashMap.modify(draft, "total", (count) => count + 1)
        HashMap.set(draft, "visited", 1)
      })
    }),
    output: (state) => ({ view: state.counts, transitions: [
      bindTransitionContext(eventAt({ type: "Requested" }, 1), "counts").intent("increment", [{ type: "Incremented" }, { type: "Incremented" }])
    ] })
  })
  const machine = machineOf(counter)
  const initial = machine.initial()
  const before = machine.output(initial).view
  const handle = bindChild(machine, initial)
  const proposal = handle.output().transitions[0]!
  if (proposal.kind !== "intent") throw new Error("expected intent")
  const preview = handle.admission().preview(proposal)
  const next = machine.step(initial, { type: "Incremented" })
  expect(HashMap.toEntries(before)).toEqual([["total", 0]])
  expect(machine.output(initial).view).toBe(before)
  expect(handle.output().view).toBe(before)
  expect(Equal.equals(machine.output(next).view, HashMap.make(["total", 1], ["visited", 1]))).toBe(true)
  expect(Equal.equals(preview.output().view, HashMap.make(["total", 2], ["visited", 1]))).toBe(true)
})

test("readonly native collections allow copying into a fresh local builder", () => {
  const counter = component({
    name: "native-counts",
    initial: (): { readonly counts: ReadonlyMap<string, number> } => ({ counts: new Map([["total", 0]]) }),
    step: (state) => {
      const counts = new Map(state.counts)
      counts.set("total", (counts.get("total") ?? 0) + 1)
      return { counts }
    },
    output: (state) => ({ view: state.counts, transitions: [] })
  })
  const machine = machineOf(counter)
  const initial = machine.initial()
  const next = machine.step(initial, { type: "Incremented" })
  expect(machine.output(initial).view.get("total")).toBe(0)
  expect(machine.output(next).view.get("total")).toBe(1)
})
