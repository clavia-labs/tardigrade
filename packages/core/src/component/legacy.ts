import { Chunk } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import type { Transition } from "@clavia/tardigrade-core/transition"
import type { KeyFragment } from "../log/keys"
import { COMPONENT_CONTRACT, type ComponentContract } from "../actor/contract"
import type { InvocationCancellation } from "../method/cancellation"
import type { Component } from "./component"
import type { ComponentOutput } from "./output"

/** @deprecated Use ComponentDefinition with component. This compatibility definition retains complete event history as machine state. */
export interface LegacyComponentDefinition<View, Requirements = never> {
  readonly name: string
  readonly derive: (log: ReadonlyArray<Event>) => ComponentOutput<View, Requirements>
  readonly cancel?: (
    log: ReadonlyArray<Event>,
    cancellation: InvocationCancellation
  ) => ReadonlyArray<Transition<never, Requirements>>
  readonly keys?: KeyFragment
  readonly [COMPONENT_CONTRACT]?: ComponentContract
}

/** @deprecated Use component. This adapter retains complete event history as machine state. */
export const legacyComponent = <View, Requirements = never>(
  definition: LegacyComponentDefinition<View, Requirements>
): Component<View, Requirements> => {
  const cancel = definition.cancel
  return {
    name: definition.name,
    machine: {
      initial: () => Chunk.empty<Event>(),
      step: (events, event) => Chunk.append(events as Chunk.Chunk<Event>, event),
      output: (events) => definition.derive(Chunk.toReadonlyArray(events as Chunk.Chunk<Event>)),
      ...(cancel === undefined
        ? {}
        : {
            cancel: (events: unknown, cancellation: InvocationCancellation) =>
              cancel(Chunk.toReadonlyArray(events as Chunk.Chunk<Event>), cancellation)
          })
    },
    ...(definition.keys === undefined ? {} : { keys: definition.keys }),
    ...(definition[COMPONENT_CONTRACT] === undefined ? {} : { [COMPONENT_CONTRACT]: definition[COMPONENT_CONTRACT] })
  }
}
