import { type ActorMethodResponse, type ResponseDelivered, type ResponseReceived } from "./events"
import { Clock, Effect, Schema } from "effect"
import { effect } from "@clavia/tardigrade-core/effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { Self } from "@clavia/tardigrade-core/runtime/reconciler"
import type { CompleteTransitionDerivation } from "@clavia/tardigrade-core/transition"
import type { KeyFragment } from "../log/index"
import { Router } from "../transport/router"
import { reverseLink, type Link } from "../transport/link"
import { formatThreadAddress, isThreadAddress, isProviderEndpoint, type ThreadAddress, type ProviderEndpoint } from "../transport/endpoint"
import { envelopeOf } from "./envelope"
import { invocationResponseId, invocationKey, sameInvocation, type InvocationRef } from "./invocation"
import { providerResponseOf } from "./provider-response"
import { initialMethodStates, reduceMethodStates, type ActorMethodState } from "./state"
import { type ActorMethodDeclaration, type ActorMethods } from "../actor/method"

import { component, type Component } from "@clavia/tardigrade-core/component"

const responseDeliveryKey = (response: { readonly method: string; readonly call: string; readonly epoch?: number }): string =>
  `mres:${invocationKey({ method: response.method, id: response.call, epoch: response.epoch ?? 0 })}`

export const methodResponseKeys: KeyFragment = {
  prefixes: ["mres:"],
  keyOf: (event) => {
    if (event.type === "ResponseDelivered") {
      return responseDeliveryKey(event as ResponseDelivered)
    }
    return undefined
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
  state: Exclude<ActorMethodState<unknown>, { readonly status: "pending" }>,
  invocation: InvocationRef
): ActorMethodResponse => ({
  state,
  invocation
})

const delivered = (log: ReadonlyArray<Event>, response: ActorMethodResponse): boolean =>
  log.some((event) =>
    event.type === "ResponseDelivered" &&
    sameInvocation({ method: String(event.method), id: String(event.call), epoch: (event as ResponseDelivered).epoch ?? 0 }, response.invocation)
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
      const response = responseOf(terminalOf(name, declaration, state), invocation)
      if (!delivered(log, response)) calls.push({ response, link: call.link })
      break
    }
  }
  return calls
}

const responseTransition = (response: ActorMethodResponse, link: Link<unknown, ThreadAddress>) =>
  effect({
      key: `mres:${invocationKey(response.invocation)}`,
      input: { response, link },
      act: ({ response: current, link: accepted }) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          yield* sendResponse(current, accepted, at)
          return [{
            type: "ResponseDelivered",
            method: current.invocation.method,
            call: current.invocation.id,
            ...(current.invocation.epoch === 0 ? {} : { epoch: current.invocation.epoch }),
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
  readonly invocation?: InvocationRef
  readonly link: Link<unknown, ThreadAddress>
}

const responseCallOf = (event: Event): IncrementalResponseCall | undefined => {
  const candidate = event as { readonly id?: unknown; readonly call?: unknown; readonly link?: unknown }
  const context = typeof candidate.call === "object" && candidate.call !== null
    ? candidate.call as { readonly invocation?: unknown }
    : undefined
  const invocation = typeof context?.invocation === "object" && context.invocation !== null
    ? context.invocation as InvocationRef
    : undefined
  const id = typeof invocation?.id === "string" ? invocation.id : candidate.id
  if (typeof id !== "string" || typeof candidate.link !== "object" || candidate.link === null ||
    !("source" in candidate.link) || !("target" in candidate.link) || !isThreadAddress(candidate.link.target)) return undefined
  return { id, ...(invocation === undefined ? {} : { invocation }),
    link: candidate.link as Link<unknown, ThreadAddress> }
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
    const response = event as ResponseDelivered
    delivered.add(invocationKey({ method: response.method, id: response.call, epoch: response.epoch ?? 0 }))
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
    invocation: InvocationRef
  ) => ActorMethodState<unknown> | undefined
): ReadonlyArray<ReturnType<typeof responseTransition>> => {
  for (const call of state.calls) {
    for (const [name, method] of Object.entries(methods)) {
      if (call.invocation !== undefined && call.invocation.method !== name) continue
      const invocation = call.invocation ?? { method: name, id: call.id, epoch: 0 }
      const current = invocationStateOf(name, method, invocation)
      if (current === undefined || current.status === "pending" || state.delivered.has(invocationKey(invocation))) continue
      const response = responseOf(terminalOf(name, method, current), invocation)
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

// sendResponse adapts a method terminal to its accepted actor or provider link.
export const sendResponse = (response: ActorMethodResponse, accepted: Link<unknown, ThreadAddress>, at: number) =>
  Effect.gen(function* () {
    const self = yield* Self
    const router = yield* Router
    const state = response.state
    if (isProviderEndpoint(accepted.source)) {
      yield* router.send(envelopeOf(
        reverseLink(accepted as Link<ProviderEndpoint, ThreadAddress>), providerResponseOf(response, self, at)
      ))
    } else if (isThreadAddress(accepted.source)) {
      const reference = { target: self, invocation: response.invocation }
      const event: ResponseReceived = {
        type: "ResponseReceived", id: invocationResponseId(reference), reference,
        method: response.invocation.method, call: response.invocation.id, status: state.status,
        ...(state.status === "completed" ? { output: state.output } : {}),
        ...(state.status === "failed" ? { error: state.error } : {}),
        ...(state.status === "cancelled" ? {
          cause: state.cause,
          ...(state.reason === undefined ? {} : { reason: state.reason }),
          ...(state.deadlineAt === undefined ? {} : { deadlineAt: state.deadlineAt })
        } : {}),
        ...(state.data === undefined ? {} : { data: state.data }), from: formatThreadAddress(self),
        ...(response.invocation.epoch === 0 ? {} : { epoch: response.invocation.epoch }), at
      }
      yield* router.send(envelopeOf(reverseLink(accepted as Link<ThreadAddress, ThreadAddress>), event))
    }
  })
