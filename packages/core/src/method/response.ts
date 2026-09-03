import { Clock, Effect, Schema } from "effect"
import { effect } from "@clavia/tardigrade-core/effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { Self } from "@clavia/tardigrade-core/runtime/reconciler"
import type { CompleteTransitionDerivation } from "@clavia/tardigrade-core/transition"
import type { KeyFragment } from "../log"
import { Router } from "../communication/router"
import { boundaryEvent } from "../communication/message"
import { envelopeOf } from "../communication/envelope"
import { reverseLink, type Link } from "../communication/link"
import {
  formatThreadAddress,
  isThreadAddress,
  isProviderEndpoint,
  type ThreadAddress,
  type ProviderEndpoint
} from "../communication/endpoint"
import {
  initialMethodStates,
  reduceMethodStates,
  type ActorMethodDeclaration,
  type ActorMethods
} from "./method"
import type { ActorMethodState } from "./state"
import { component, type Component } from "@clavia/tardigrade-core/component"
import type { ActorInvocation } from "./call"

// ActorMethodResponse is the terminal response correlated to one method call.
export interface ActorMethodResponse<Output = unknown> {
  readonly method: string
  readonly call: string
  readonly state: Exclude<ActorMethodState<Output>, { readonly status: "pending" }>
}

// ResponseReceived is a method response accepted into the caller's private log.
export interface ResponseReceived extends Event {
  readonly type: "ResponseReceived"
  readonly id: string
  readonly method: string
  readonly call: string
  readonly status: "completed" | "failed" | "cancelled"
  readonly output?: unknown
  readonly error?: string
  readonly cause?: "requested" | "deadline"
  readonly reason?: string
  readonly deadlineAt?: number
  readonly data?: unknown
  readonly from: string
  readonly at: number
}

// ResponseDelivered records that one terminal crossed its accepted call link.
export interface ResponseDelivered extends Event {
  readonly type: "ResponseDelivered"
  readonly method: string
  readonly call: string
  readonly at: number
}

export const methodResponseKeys: KeyFragment = {
  prefixes: ["mres:"],
  keyOf: (event) => {
    if (event.type === "ResponseDelivered") {
      return `mres:${String((event as { readonly method?: unknown }).method)}:${String((event as { readonly call?: unknown }).call)}`
    }
    return undefined
  }
}

const textOf = (state: Exclude<ActorMethodState<unknown>, { readonly status: "pending" }>): string => {
  if (state.status === "failed") return `error: ${state.error}`
  if (state.status === "cancelled") return state.reason === undefined ? "cancelled" : `cancelled: ${state.reason}`
  if (typeof state.output === "string") return state.output
  try {
    return JSON.stringify(state.output) ?? String(state.output)
  } catch {
    return String(state.output)
  }
}

const terminalOf = (
  name: string,
  method: ActorMethodDeclaration,
  state: Exclude<ActorMethodState<unknown>, { readonly status: "pending" }>
): Exclude<ActorMethodState<unknown>, { readonly status: "pending" }> => {
  if (state.status === "failed") return state
  if (state.status === "cancelled") return state
  try {
    return {
      status: "completed",
      output: Schema.decodeUnknownSync(method.output)(state.output),
      ...(state.data === undefined ? {} : { data: state.data })
    }
  } catch (failure) {
    return {
      status: "failed",
      error: `invalid ${name} output: ${failure instanceof Error ? failure.message : String(failure)}`,
      ...(state.data === undefined ? {} : { data: state.data })
    }
  }
}

const responseOf = (
  method: string,
  call: string,
  state: Exclude<ActorMethodState<unknown>, { readonly status: "pending" }>
): ActorMethodResponse => ({
  method,
  call,
  state
})

const delivered = (log: ReadonlyArray<Event>, response: ActorMethodResponse): boolean =>
  log.some((event) =>
    event.type === "ResponseDelivered" &&
    String((event as { readonly method?: unknown }).method) === response.method &&
    String((event as { readonly call?: unknown }).call) === response.call
  )

const linkedCalls = (
  log: ReadonlyArray<Event>,
  methods: ActorMethods
): ReadonlyArray<{ readonly response: ActorMethodResponse; readonly link: Link<unknown, ThreadAddress> }> => {
  const calls: Array<{ readonly response: ActorMethodResponse; readonly link: Link<unknown, ThreadAddress> }> = []
  for (const event of log) {
    const call = responseCallOf(event)
    if (call === undefined) continue
    for (const [name, method] of Object.entries(methods)) {
      if (call.invocation !== undefined && call.invocation.method !== name) continue
      const invocation = call.invocation ?? { method: name, id: call.id, epoch: 0 }
      const declaration = method as ActorMethodDeclaration
      const state = declaration.state(log, invocation)
      if (state === undefined || state.status === "pending") continue
      const response = responseOf(name, call.id, terminalOf(name, declaration, state))
      if (!delivered(log, response)) calls.push({ response, link: call.link })
      break
    }
  }
  return calls
}

const responseTransition = (response: ActorMethodResponse, link: Link<unknown, ThreadAddress>) =>
  effect({
      key: `mres:${response.method}:${response.call}`,
      input: { response, link },
      act: ({ response: current, link: accepted }) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          const self = yield* Self
          const router = yield* Router
          const state = current.state
          const message = boundaryEvent({
            turn: current.call,
            round: 0,
            text: textOf(state),
            outcome: state.status,
            from: formatThreadAddress(self),
            ...(state.data === undefined ? {} : { data: state.data }),
            at
          })
          if (isProviderEndpoint(accepted.source)) {
            yield* router.send(envelopeOf(
              reverseLink(accepted as Link<ProviderEndpoint, ThreadAddress>),
              message
            ))
          } else if (isThreadAddress(accepted.source)) {
            const responseEvent: ResponseReceived = {
              type: "ResponseReceived",
              id: message.id,
              method: current.method,
              call: current.call,
              status: state.status,
              ...(state.status === "completed" ? { output: state.output } : {}),
              ...(state.status === "failed" ? { error: state.error } : {}),
              ...(state.status === "cancelled" ? {
                cause: state.cause,
                ...(state.reason === undefined ? {} : { reason: state.reason }),
                ...(state.deadlineAt === undefined ? {} : { deadlineAt: state.deadlineAt })
              } : {}),
              ...(state.data === undefined ? {} : { data: state.data }),
              from: formatThreadAddress(self),
              at
            }
            yield* router.send(envelopeOf(
              reverseLink(accepted as Link<ThreadAddress, ThreadAddress>),
              responseEvent
            ))
          }
          return [{
            type: "ResponseDelivered",
            method: current.method,
            call: current.call,
            at
          } satisfies ResponseDelivered]
        })
    })

// methodResponseDerivation derives method reports from linked calls and their declared state projections.
export const methodResponseDerivation = (methods: ActorMethods): CompleteTransitionDerivation<Router | Self> => (log) =>
  linkedCalls(log, methods).slice(0, 1).map(({ response, link }) => responseTransition(response, link))

/** @deprecated Use methodResponseDerivation. This compatibility name describes a complete-history transition derivation. */
export const methodResponseReactor = (methods: ActorMethods): CompleteTransitionDerivation<Router | Self> =>
  methodResponseDerivation(methods)

interface IncrementalResponseCall {
  readonly id: string
  readonly invocation?: ActorInvocation
  readonly link: Link<unknown, ThreadAddress>
}

const responseCallOf = (event: Event): IncrementalResponseCall | undefined => {
  const candidate = event as { readonly id?: unknown; readonly call?: unknown; readonly link?: unknown }
  const context = typeof candidate.call === "object" && candidate.call !== null
    ? candidate.call as { readonly invocation?: unknown }
    : undefined
  const invocation = typeof context?.invocation === "object" && context.invocation !== null
    ? context.invocation as ActorInvocation
    : undefined
  const id = typeof invocation?.id === "string" ? invocation.id : candidate.id
  if (typeof id !== "string" || typeof candidate.link !== "object" || candidate.link === null ||
    !("source" in candidate.link) || !("target" in candidate.link) || !isThreadAddress(candidate.link.target)) return undefined
  return { id, ...(invocation === undefined ? {} : { invocation }), link: candidate.link as Link<unknown, ThreadAddress> }
}

export interface MethodResponseProjectionState {
  readonly calls: ReadonlyArray<IncrementalResponseCall>
  readonly delivered: ReadonlySet<string>
}

// initialMethodResponseState constructs response delivery bookkeeping.
export const initialMethodResponseState = (): MethodResponseProjectionState => ({
  calls: [],
  delivered: new Set()
})

// reduceMethodResponseState advances response delivery bookkeeping with one event.
export const reduceMethodResponseState = (
  state: MethodResponseProjectionState,
  event: Event
): MethodResponseProjectionState => {
  const delivered = new Set(state.delivered)
  if (event.type === "ResponseDelivered") {
    delivered.add(`${String((event as { readonly method?: unknown }).method)}:${String((event as { readonly call?: unknown }).call)}`)
  }
  const accepted = responseCallOf(event)
  return { calls: accepted === undefined ? state.calls : [...state.calls, accepted], delivered }
}

// methodResponseTransitions derives the next terminal delivery from projected method views.
export const methodResponseTransitions = (
  methods: ActorMethods,
  state: MethodResponseProjectionState,
  invocationStateOf: (
    name: string,
    method: ActorMethodDeclaration,
    invocation: ActorInvocation
  ) => ActorMethodState<unknown> | undefined
): ReadonlyArray<ReturnType<typeof responseTransition>> => {
  for (const call of state.calls) {
    for (const [name, method] of Object.entries(methods)) {
      if (call.invocation !== undefined && call.invocation.method !== name) continue
      const invocation = call.invocation ?? { method: name, id: call.id, epoch: 0 }
      const current = invocationStateOf(name, method, invocation)
      if (current === undefined || current.status === "pending" || state.delivered.has(`${name}:${call.id}`)) continue
      const response = responseOf(name, call.id, terminalOf(name, method, current))
      return [responseTransition(response, call.link)]
    }
  }
  return []
}

// methodResponseComponent adapts declared method states into response transitions.
export const methodResponseComponent = (methods: ActorMethods): Component<undefined, Router | Self> => {
  interface State {
    readonly methods: ReadonlyMap<string, unknown>
    readonly response: MethodResponseProjectionState
  }
  return component<State, undefined, Router | Self>({
    name: "actor.methods",
    keys: methodResponseKeys,
    initial: () => ({
      methods: initialMethodStates(methods),
      response: initialMethodResponseState()
    }),
    step: (state, event) => ({
      methods: reduceMethodStates(methods, state.methods, event),
      response: reduceMethodResponseState(state.response, event)
    }),
    output: (state) => ({
      view: undefined,
      transitions: methodResponseTransitions(
        methods,
        state.response,
        (name, method, invocation) => method.projection.output(state.methods.get(name)).invocationState(invocation)
      )
    })
  })
}
