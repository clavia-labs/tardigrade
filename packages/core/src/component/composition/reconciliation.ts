import type { Event } from "@clavia/tardigrade-core/event"
import type { Transition } from "@clavia/tardigrade-core/transition"
import type { ComponentOutput, ComponentWork } from "../output"

// TransitionReconciler selects work from the complete child transition set before external effects begin. It returns only transitions it received, each at most once (component/composition/siblings.test.ts, "composition refuses work a reconciler did not receive" and "composition refuses a transition selected more than once").
export type TransitionReconciler<Requirements = never, View = unknown> = (
  log: ReadonlyArray<Event>,
  transitions: ReadonlyArray<Transition<never, Requirements>>,
  view: View
) => ReadonlyArray<Transition<never, Requirements>>

// independentTransitions preserves every transition in child order.
export const independentTransitions = <Requirements>(
  _log: ReadonlyArray<Event>,
  transitions: ReadonlyArray<Transition<never, Requirements>>
): ReadonlyArray<Transition<never, Requirements>> => transitions

// reconcileComponentOutput applies a reconciler and enforces its selection contract (component/composition/siblings.test.ts, "composition refuses work a reconciler did not receive" and "composition refuses a transition selected more than once").
export const reconcileComponentOutput = <View, Requirements, Result = never, Interactions = unknown>(
  name: string,
  reconcile: TransitionReconciler<Requirements, View> | undefined,
  log: ReadonlyArray<Event>,
  output: ComponentOutput<View, Requirements, Result, Interactions>
): ComponentOutput<View, Requirements, Result, Interactions> => {
  const transitions = output.transitions
  if (reconcile === undefined || transitions.length === 0) return output
  const resolved = reconcile(log, transitions, output.view)
  const received = new Set(transitions)
  const seen = new Set<Transition<never, Requirements>>()
  for (const selected of resolved) {
    if (!received.has(selected)) {
      throw new Error(`component "${name}" reconciler returned work outside its transition set`)
    }
    if (seen.has(selected)) {
      throw new Error(`component "${name}" reconciler returned transition "${selected.key}" more than once`)
    }
    seen.add(selected)
  }
  return { ...output, transitions: resolved as ReadonlyArray<ComponentWork<Requirements, Result>> }
}
