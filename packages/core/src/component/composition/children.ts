import type { ComponentReadonly } from "../readonly"
import { eventAt } from "../../event"
import type { Intent } from "../../intent"
import type { ComponentMachine } from "../machine"
import type { Component, ComponentView, ComponentInteractions, ComponentRequirements, ComponentResult } from "../component"
import type { ComponentOutput } from "../output"

// ChildAdmission reserves offered intents without advancing the bound snapshot (children.test.ts).
export interface ChildAdmission<View> {
  readonly output: () => { readonly view: View }
  readonly preview: (proposal: Intent<never>) => ChildAdmission<View>
}

/**
 * ChildHandle binds public queries and interactions to one snapshot (children.test.ts).
 *
 *   Child machine + snapshot
 *             |
 *          bindChild
 *             |
 *         ChildHandle
 *         |-- output()
 *         |     +-- interactions.cancel(...)
 *         +-- admission()
 *                   |
 *              ChildAdmission
 *              |-- output().view
 *              +-- preview(proposal)
 */
export interface ChildHandle<View, Requirements = never, Result = never, Interactions = unknown> {
  readonly output: () => ComponentOutput<View, Requirements, Result, Interactions>
  // admission evaluates offered intents without changing the bound snapshot (children.test.ts).
  readonly admission: () => ChildAdmission<View>
}

export type ComponentChildren = Component<unknown, unknown> | ReadonlyArray<Component<unknown, unknown>>

export type ChildOf<C extends ComponentChildren> = C extends Component<unknown, unknown>
  ? ChildHandle<ComponentReadonly<ComponentView<C>>, ComponentRequirements<C>, ComponentResult<C>, ComponentInteractions<C>>
  : { readonly [K in keyof C]: C[K] extends Component<unknown, unknown> ? ChildOf<C[K]> : never }

const admission = (machine: ComponentMachine<unknown, unknown>, snapshot: unknown, position: number, at: number): ChildAdmission<unknown> => {
  const offered = new Set(machine.output(snapshot).transitions)
  const candidate = (state: unknown, head: number, accepted: ReadonlySet<Intent<never>>): ChildAdmission<unknown> => Object.freeze({
    output: () => ({ view: machine.output(state).view }),
    preview: (proposal: Intent<never>) => {
      if (!offered.has(proposal) || proposal.kind !== "intent") throw new Error("admission requires an intent from this child output")
      if (accepted.has(proposal)) throw new Error("admission cannot reserve a proposal twice")
      const events = proposal.events(proposal.input, at)
      const next = events.reduce((current, event, index) => machine.step(current, eventAt(event, head + index + 1)), state)
      return candidate(next, head + events.length, new Set([...accepted, proposal]))
    }
  })
  return candidate(snapshot, position, new Set())
}

// bindChild exposes public operations without revealing its snapshot (children.test.ts).
export const bindChild = (machine: ComponentMachine<unknown, unknown>, snapshot: unknown, position = 0, at = 0): ChildHandle<unknown, unknown, never> => {
  const handle: ChildHandle<unknown, unknown, never> = {
    output: () => machine.output(snapshot),
    admission: () => admission(machine, snapshot, position, at)
  }
  return Object.freeze(handle)
}
