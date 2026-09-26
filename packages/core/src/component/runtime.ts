import { validateView } from "./data"
import { TRANSITION_COMPONENT_IDS, validateTransitions } from "../transition/transition"
import { eraseTransitionProjection, type ErasedTransitionProjection } from "../transition/projection"
import type { Component } from "./component"
import type { ComponentOutput } from "./output"
import type { ComponentMachine } from "./machine"

const registration: unique symbol = Symbol("component.registration")
const machines = new WeakMap<object, ComponentMachine<unknown, unknown, never>>()
type Registered = { readonly [registration]?: object }

// registerComponent keeps lifecycle machinery outside the public declaration (runtime.test.ts).
export const registerComponent = <Fields extends { readonly name: string }, View, Requirements, Result, Interactions>(
  fields: Fields,
  machine: ComponentMachine<View, Requirements, Result, Interactions>
): Fields & Component<View, Requirements, Result, Interactions> => {
  const token = Object.freeze({})
  const validated = new WeakMap<object, ComponentOutput<View, Requirements, Result, Interactions>>()
  const accepted = new WeakSet<object>()
  machines.set(token, { ...machine, output: state => {
    const output = machine.output(state)
    const cached = validated.get(output)
    if (cached !== undefined) return cached
    validateView(output.view, accepted)
    const cancel = output.interactions?.cancel
    const checked = cancel === undefined ? output : {
      ...output,
      interactions: { ...output.interactions!, cancel: (cancellation: Parameters<typeof cancel>[0]) => validateTransitions(cancel(cancellation)) }
    }
    validated.set(output, checked)
    return checked
  } })
  return { ...fields, [registration]: token } as unknown as Fields & Component<View, Requirements, Result, Interactions>
}

// machineOf grants framework internals access to a registered component's lifecycle.
export const machineOf = <View, Requirements, Result, Interactions>(
  component: Component<View, Requirements, Result, Interactions>
): ComponentMachine<View, Requirements, Result, Interactions> => {
  const token = (component as Registered)[registration]
  const machine = token === undefined ? undefined : machines.get(token)
  if (machine === undefined) throw new TypeError(`component "${component.name}" is not registered`)
  return machine as ComponentMachine<View, Requirements, Result, Interactions>
}

// transitionProjectionOf exposes a component's enabled work as a transition projection.
export const transitionProjectionOf = <V, R>(component: Component<V, R>): ErasedTransitionProjection<R> => {
  const machine = machineOf(component)
  return {
    [TRANSITION_COMPONENT_IDS]: component[TRANSITION_COMPONENT_IDS] ?? [],
    ...eraseTransitionProjection({
      initial: machine.initial,
      step: machine.step,
      output: (state) => machine.output(state).transitions
    })
  }
}
