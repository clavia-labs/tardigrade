import type { Event } from "@clavia/tardigrade-core/event"
import type { Transition } from "@clavia/tardigrade-core/transition"
import type { InvocationCancellation } from "../actor/method/cancellation"
import type { Component, ComponentOutput } from "./component"

// CompleteComponentProjection defines the complete-history behavior used as a refinement oracle during migration.
export interface CompleteComponentProjection<View, Requirements = never> {
  readonly derive: (log: ReadonlyArray<Event>) => ComponentOutput<View, Requirements>
  readonly cancel?: (
    log: ReadonlyArray<Event>,
    cancellation: InvocationCancellation
  ) => ReadonlyArray<Transition<never, Requirements>>
}

// ComponentRefinementStep pairs complete replay with incremental observations at one history prefix.
export interface ComponentRefinementStep<View, Requirements = never> {
  readonly prefix: ReadonlyArray<Event>
  readonly replay: ComponentOutput<View, Requirements>
  readonly incremental: ComponentOutput<View, Requirements>
  readonly cancellations: ReadonlyArray<{
    readonly cancellation: InvocationCancellation
    readonly replay: ReadonlyArray<Transition<never, Requirements>>
    readonly incremental: ReadonlyArray<Transition<never, Requirements>>
  }>
}

// componentRefinementTrace observes complete replay and incremental execution at every history prefix.
export const componentRefinementTrace = <View, Requirements>(
  complete: CompleteComponentProjection<View, Requirements>,
  component: Component<View, Requirements>,
  log: ReadonlyArray<Event>,
  cancellationsAt: (prefix: ReadonlyArray<Event>) => ReadonlyArray<InvocationCancellation> = () => []
): ReadonlyArray<ComponentRefinementStep<View, Requirements>> => {
  const machine = component.machine
  let state = machine.initial()
  const trace: Array<ComponentRefinementStep<View, Requirements>> = []
  for (let length = 0; length <= log.length; length++) {
    const prefix = log.slice(0, length)
    trace.push({
      prefix,
      replay: complete.derive(prefix),
      incremental: machine.output(state),
      cancellations: cancellationsAt(prefix).map((cancellation) => ({
        cancellation,
        replay: complete.cancel?.(prefix, cancellation) ?? [],
        incremental: machine.cancel?.(state, cancellation) ?? []
      }))
    })
    const event = log[length]
    if (event !== undefined) state = machine.step(state, event)
  }
  return trace
}
