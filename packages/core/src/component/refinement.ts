import type { Context } from "effect"
import { machineOf } from "./runtime"
import { eventAt, eventPositionOf, type Event } from "@clavia/tardigrade-core/event"
import type { Transition } from "@clavia/tardigrade-core/transition"
import type { InvocationCancellation } from "../interaction/events"
import type { Component } from "./component"
import type { ComponentOutput } from "./output"

// CompleteComponentProjection defines the complete-history behavior used as a refinement oracle during migration.
export interface CompleteComponentProjection<View, Requirements = never> {
  readonly derive: (log: ReadonlyArray<Event>) => ComponentOutput<View, Requirements, never>

}

// ComponentRefinementStep pairs complete replay with incremental views at one history prefix.
export interface ComponentRefinementStep<View, Requirements = never> {
  readonly prefix: ReadonlyArray<Event>
  readonly replay: ComponentOutput<View, Requirements, never>
  readonly incremental: ComponentOutput<View, Requirements, never>
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
  cancellationsAt: (prefix: ReadonlyArray<Event>) => ReadonlyArray<InvocationCancellation> = () => [],
  data?: Context.Context<never>
): ReadonlyArray<ComponentRefinementStep<View, Requirements>> => {
  const positioned = log.map((event, index) => eventAt(event, eventPositionOf(event) ?? index + 1))
  const machine = machineOf(component)
  let state = machine.initial(data)
  const trace: Array<ComponentRefinementStep<View, Requirements>> = []
  for (let length = 0; length <= log.length; length++) {
    const prefix = positioned.slice(0, length)
    const replay = complete.derive(prefix)
    const incremental = machine.output(state)
    trace.push({
      prefix,
      replay,
      incremental,
      cancellations: cancellationsAt(prefix).map((cancellation) => ({
        cancellation,
        replay: replay.interactions?.cancel?.(cancellation) ?? [],
        incremental: incremental.interactions?.cancel?.(cancellation) ?? []
      }))
    })
    const event = positioned[length]
    if (event !== undefined) state = machine.step(state, event)
  }
  return trace
}
