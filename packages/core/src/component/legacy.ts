import { TRANSITION_COMPONENT_IDS } from "../transition/transition"
import { Chunk } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import type { Transition } from "@clavia/tardigrade-core/transition"
import type { KeyFragment } from "../log/keys"
import type { SubjectFragment } from "../log/subjects"
import { COMPONENT_CONTRACT, type ComponentContract } from "../actor/contract"
import type { InvocationCancellation } from "../interaction/events"
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
  readonly subjects?: SubjectFragment
  readonly [COMPONENT_CONTRACT]?: ComponentContract
}

/** @deprecated Use component. This adapter retains complete event history as machine state. */
export const legacyComponent = <View, Requirements = never>(
  definition: LegacyComponentDefinition<View, Requirements>
): Component<View, Requirements> => {
  if (typeof definition.name !== "string" || definition.name.length === 0) throw new Error("components require a nonempty name")
  const cancel = definition.cancel
  return {
    name: definition.name,
    [TRANSITION_COMPONENT_IDS]: [definition.name],
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
    ...(definition.subjects === undefined ? {} : { subjects: definition.subjects }),
    ...(definition[COMPONENT_CONTRACT] === undefined ? {} : { [COMPONENT_CONTRACT]: definition[COMPONENT_CONTRACT] })
  }
}
