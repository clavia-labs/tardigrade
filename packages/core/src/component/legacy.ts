import { registerComponent } from "./runtime"
import { TRANSITION_COMPONENT_IDS } from "../transition/transition"
import { Chunk } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import type { KeyFragment } from "../log/keys"
import { COMPONENT_CONTRACT, type ComponentContract } from "../actor/contract"
import type { Component } from "./component"
import type { ComponentOutput } from "./output"

/** @deprecated Use ComponentDefinition with component. This compatibility definition retains complete event history as machine state. */
export interface LegacyComponentDefinition<View, Requirements = never, Interactions = unknown> {
  readonly name: string
  readonly derive: (log: ReadonlyArray<Event>) => ComponentOutput<View, Requirements, never, Interactions>

  readonly keys?: KeyFragment
  readonly [COMPONENT_CONTRACT]?: ComponentContract
}

/** @deprecated Use component. This adapter retains complete event history as machine state. */
export const legacyComponent = <View, Requirements = never, Interactions = unknown>(
  definition: LegacyComponentDefinition<View, Requirements, Interactions>
): Component<View, Requirements, never, Interactions> => {
  if (typeof definition.name !== "string" || definition.name.length === 0) throw new Error("components require a nonempty name")
  return registerComponent({
    name: definition.name,
    [TRANSITION_COMPONENT_IDS]: [definition.name],
    ...(definition.keys === undefined ? {} : { keys: definition.keys }),
    ...(definition[COMPONENT_CONTRACT] === undefined ? {} : { [COMPONENT_CONTRACT]: definition[COMPONENT_CONTRACT] })
  }, {
    initial: () => Chunk.empty<Event>(),
    step: (events, event) => Chunk.append(events as Chunk.Chunk<Event>, event),
    output: (events) => definition.derive(Chunk.toReadonlyArray(events as Chunk.Chunk<Event>))
  })
}
