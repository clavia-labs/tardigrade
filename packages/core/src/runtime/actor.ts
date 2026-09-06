import { actorFromProjections, type Actor, type Self } from "./reconciler"
import { transitionProjectionOf, type Component } from "../component/index"
import { composeKeys } from "../log/index"
import type { Router } from "../transport/router"
import { methodCallKeys } from "../interaction/invoke"
import { methodResponseKeys } from "../interaction/respond"
import { methodInputValidationComponents } from "../actor/validation"
import { methodTimeoutKeys } from "../interaction/timeout"
import { type ActorMethods } from "../actor/method"
import { CANCELLATION_CONTROL_METHOD, cancellationKeys, cancellationMethodFor, childCancellationTimeoutOf } from "../interaction/cancellation"
import { actorProjection } from "./projection"
import type { Actor as ActorDefinition } from "../actor/definition"

export type ActorSource<R> = Actor<R> | ActorDefinition<R>

const compiled = new WeakMap<object, Actor<unknown>>()

// actorRuntimeOf resolves a definition to its cached runtime or accepts an existing runtime.
export const actorRuntimeOf = <R>(source: ActorSource<R>): Actor<R> => {
  if ("projections" in source) return source
  const cached = compiled.get(source)
  if (cached !== undefined) return cached as Actor<R>
  const runtime = compileActor(source.methods, source.components, childCancellationTimeoutOf(source.cancellation?.childTimeoutMs))
  compiled.set(source, runtime)
  return runtime as Actor<R>
}

// compileActor assembles validation, event identity, and lifecycle projections for an actor.
export const compileActor = <R>(
  methods: ActorMethods,
  components: ReadonlyArray<Component<unknown, R>>,
  childTimeoutMs: number
): Actor<R | Router | Self> => {
  const inputValidation = methodInputValidationComponents(methods)
  const fragments = [...inputValidation, ...components].flatMap((component) => component.keys === undefined ? [] : [component.keys])
  const responseMethods = {
    ...methods,
    [CANCELLATION_CONTROL_METHOD]: cancellationMethodFor(methods)
  }
  const keyOf = composeKeys(...fragments, cancellationKeys, methodCallKeys, methodTimeoutKeys, methodResponseKeys)
  const projection = actorProjection(methods, responseMethods, components, keyOf, childTimeoutMs)
  const validationProjections = inputValidation.map(transitionProjectionOf)
  return actorFromProjections({
    transitions: validationProjections,
    guards: validationProjections,
    control: projection,
    keyOf
  })
}
