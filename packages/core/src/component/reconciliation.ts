import type { Event } from "@clavia/tardigrade-core/event"
import type { Transition } from "@clavia/tardigrade-core/transition"
import type { ComponentOutput } from "./output"

// TransitionReconciler selects work from the complete child transition set before external effects begin. It returns only transitions it received, each at most once (component/compose.test.ts, "composition refuses work a reconciler did not receive" and "composition refuses a transition selected more than once").
export type TransitionReconciler<Requirements = never> = (
  log: ReadonlyArray<Event>,
  transitions: ReadonlyArray<Transition<never, Requirements>>
) => ReadonlyArray<Transition<never, Requirements>>

// independentTransitions preserves every transition in child order.
export const independentTransitions = <Requirements>(
  _log: ReadonlyArray<Event>,
  transitions: ReadonlyArray<Transition<never, Requirements>>
): ReadonlyArray<Transition<never, Requirements>> => transitions

// reconcileComponentOutput applies a reconciler and enforces its selection contract (component/compose.test.ts, "composition refuses work a reconciler did not receive" and "composition refuses a transition selected more than once").
export const reconcileComponentOutput = <View, Requirements>(
  name: string,
  reconcile: TransitionReconciler<Requirements> | undefined,
  log: ReadonlyArray<Event>,
  output: ComponentOutput<View, Requirements>
): ComponentOutput<View, Requirements> => {
  const transitions = output.transitions
  if (reconcile === undefined || transitions.length === 0) return output
  const resolved = reconcile(log, transitions)
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
  return { view: output.view, transitions: resolved }
}
