import type { Event } from "@clavia/tardigrade-core/event"
import type { Component } from "@clavia/tardigrade-core/component"
import type { ActorProjection, Self } from "@clavia/tardigrade-core/runtime/reconciler"
import type { Transition } from "@clavia/tardigrade-core/transition"
import type { Router } from "../communication/router"
import {
  CANCELLATION_CONTROL_METHOD,
  actorCancellationComponentTransitions,
  actorCancellationMethodStates,
  actorCancellationProjection,
  cancellationMethodStateOf
} from "../method/cancellation"
import {
  initialMethodResponseState,
  methodResponseTransitions,
  reduceMethodResponseState,
  type MethodResponseProjectionState
} from "../method/response"
import {
  initialMethodTimeoutState,
  methodTimeoutTransitions,
  reduceMethodTimeoutState,
  type MethodTimeoutProjectionState
} from "../method/timeout"
import type { ActorMethods } from "../method/method"

interface ActorProjectionState {
  readonly cancellation: unknown
  readonly response: MethodResponseProjectionState
  readonly timeout: MethodTimeoutProjectionState
}

// actorProjection owns component, method, response, timeout, and cancellation state for one actor log.
export const actorProjection = <R>(
  methods: ActorMethods,
  responseMethods: ActorMethods,
  components: ReadonlyArray<Component<unknown, R>>,
  keyOf: (event: Event) => string | undefined,
  childTimeoutMs: number
): ActorProjection<R | Router | Self> => {
  const cancellation = actorCancellationProjection(methods, components, keyOf, childTimeoutMs)!
  return {
    initial: (): ActorProjectionState => ({
      cancellation: cancellation.initial(),
      response: initialMethodResponseState(),
      timeout: initialMethodTimeoutState()
    }),
    step: (erased, event): ActorProjectionState => {
      const state = erased as ActorProjectionState
      return {
        cancellation: cancellation.step(state.cancellation, event),
        response: reduceMethodResponseState(state.response, event),
        timeout: reduceMethodTimeoutState(state.timeout, event)
      }
    },
    output: (erased) => {
      const state = erased as ActorProjectionState
      const methodStates = actorCancellationMethodStates(state.cancellation)
      const cancellationOutput = cancellation.output(state.cancellation)
      const continuations = [
        ...actorCancellationComponentTransitions(state.cancellation, components),
        ...methodTimeoutTransitions(methods, methodStates, state.timeout),
        ...methodResponseTransitions(
          responseMethods,
          state.response,
          (name, method, invocation) => name === CANCELLATION_CONTROL_METHOD
            ? cancellationMethodStateOf(methods, state.cancellation, invocation)
            : method.projection.output(methodStates.get(name)).invocationState(invocation)
        )
      ] as ReadonlyArray<Transition<never, R | Router | Self>>
      return {
        continuations,
        cancellationOf: cancellationOutput.cancellationOf,
        suppresses: cancellationOutput.suppresses,
        residuals: cancellationOutput.residuals
      }
    }
  }
}
