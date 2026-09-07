import { Effect, Schema } from "effect"
import { effect, type ExternalEffect } from "../effect"
import { intent, type Intent } from "../intent"
import { Event, eventPositionOf } from "../event"
import type { EventLog } from "../log/service"

/**
 * Transition is an Intent or ExternalEffect offered from one event snapshot.
 *
 *   Transition<Input, Requirements>
 *              │          │
 *              │          └─ services an external effect may require
 *              └──────────── private input carried by the work
 *
 * Intent proposes events directly. ExternalEffect performs outside-world work before returning events. Their kind field lets the runtime distinguish them while preserving one ordered work collection.
 */
export type Transition<Input = unknown, Requirements = never> =
  | Intent<Input>
  | ExternalEffect<Input, Requirements>

// TransitionRef identifies a tagged obligation within its owning log (runtime/reconciler.properties.test.ts).
export const TransitionRef = Schema.Struct({
  seq: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  component: Schema.NonEmptyString,
  tag: Schema.NonEmptyString
})
export type TransitionRef = typeof TransitionRef.Type

// transitionKey derives a log-local transition key from runtime-owned coordinates.
const transitionKey = (ref: TransitionRef): string => JSON.stringify([ref.seq, ref.component, ref.tag])

// transitionKeyOf derives identity from runtime-attached completion metadata (runtime/reconciler.properties.test.ts).
export const transitionKeyOf = (event: Event): string | undefined => "transitionRef" in event
  ? transitionKey(Schema.decodeUnknownSync(TransitionRef)(event.transitionRef))
  : undefined

// TaggedEffectOptions declares an action whose completion identity is supplied by its context.
interface TaggedEffectOptions<Input, Result extends Event, Requirements = never> {
  readonly key?: never
  readonly ref?: never
  readonly input: Input
  readonly act: (input: Input, context: { readonly signal: AbortSignal }) => Effect.Effect<Result, never, EventLog | Requirements>
}

// TransitionContext binds tagged declarations and result queries to one component and event (runtime/reconciler.properties.test.ts).
export interface TransitionContext {
  readonly effect: <Input, Result extends Event, Requirements = never>(tag: string, options: TaggedEffectOptions<Input, Result, Requirements>) => ExternalEffect<never, Requirements>
  readonly intent: (tag: string, completion: Event) => Intent<never>
  readonly matches: (tag: string, event: Event) => boolean
}

const references = new WeakMap<object, TransitionRef>()

// bindTransitionContext supplies tagged declarations for an event delivered to a component reducer.
export const bindTransitionContext = (event: Event, component: string, enabled: boolean): TransitionContext => {
  const reference = (tag: string): TransitionRef => {
    if (!enabled) throw new Error('tagged transitions require keys: "runtime" on its component')
    const seq = eventPositionOf(event)
    if (seq === undefined) throw new Error("tagged transitions require a recorded event position")
    return Object.freeze(Schema.decodeSync(TransitionRef)({ seq, component, tag }))
  }
  const complete = (transitionRef: TransitionRef, completion: Event): Event => {
    Schema.decodeSync(Event)(completion)
    if ("transitionRef" in completion) throw new Error("completion event already carries a transition reference")
    return { ...completion, transitionRef }
  }
  return Object.freeze({
    effect: <Input, Result extends Event, Requirements = never>(tag: string, options: TaggedEffectOptions<Input, Result, Requirements>) => {
      if (options.key !== undefined || options.ref !== undefined) throw new Error("transition identity is supplied by the runtime")
      const ref = reference(tag)
      const transition = Object.freeze(effect({
        key: transitionKey(ref),
        input: options.input,
        act: (input: Input, signal: AbortSignal) => Effect.map(options.act(input, { signal }), (result) => [complete(ref, result)])
      }))
      references.set(transition, ref)
      return transition
    },
    intent: (tag: string, result: Event) => {
      const ref = reference(tag)
      const transition = Object.freeze(intent({ key: transitionKey(ref), input: result, events: (input) => [complete(ref, input)] }))
      references.set(transition, ref)
      return transition
    },
    matches: (tag: string, completion: Event) => transitionKey(reference(tag)) === transitionKeyOf(completion)
  })
}

// validateTransitions rejects duplicate tagged obligations before dispatch (runtime/reconciler.properties.test.ts).
export const validateTransitions = <R>(transitions: ReadonlyArray<Transition<never, R>>): ReadonlyArray<Transition<never, R>> => {
  const seen = new Set<string>()
  for (const transition of transitions) {
    const ref = references.get(transition)
    if (ref === undefined) continue
    if (seen.has(transition.key)) throw new Error(`duplicate transition tag "${ref.tag}" for component "${ref.component}" at event ${ref.seq}`)
    seen.add(transition.key)
  }
  return transitions
}

export const TRANSITION_COMPONENT_IDS = Symbol("transitionComponentIds")

// transitionComponentIds validates stable identities across nested work components (runtime/reconciler.properties.test.ts).
export const transitionComponentIds = (components: ReadonlyArray<{ readonly [TRANSITION_COMPONENT_IDS]?: ReadonlyArray<string> }>): ReadonlyArray<string> => {
  const seen = new Set<string>()
  for (const component of components) {
    for (const id of component[TRANSITION_COMPONENT_IDS] ?? []) {
      if (seen.has(id)) throw new Error(`duplicate component identity "${id}"`)
      seen.add(id)
    }
  }
  return [...seen]
}
