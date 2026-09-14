import { type ActorMethodResponse, type ResponseDelivered, type ResponseReceived } from "./events"
import { Clock, Effect, Schema } from "effect"
import { eventAt, eventPositionOf, type Event } from "@clavia/tardigrade-core/event"
import { bindTransitionContext } from "../transition/transition"
import { Self } from "../runtime/context"
import type { CompleteTransitionDerivation } from "@clavia/tardigrade-core/transition"
import type { KeyFragment } from "../log/index"
import { Router } from "../transport/router"
import { reverseLink, type Link } from "../transport/link"
import { formatThreadAddress, isThreadAddress, isProviderEndpoint, type ThreadAddress, type ProviderEndpoint } from "../transport/endpoint"
import { envelopeOf } from "./envelope"
import { invocationResponseId, invocationKey, invocationCoordinateKey, type InvocationRef } from "./invocation"
import { invocationDetachedOf, reduceReplyState, replyStateOf, type ReplyState } from "./detach"
import { acceptedCallOf, type AcceptedCall } from "./records-compat"
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

const linkedCalls = (
  log: ReadonlyArray<Event>,
  methods: ActorMethods
): ReadonlyArray<{ readonly response: ActorMethodResponse; readonly link: Link<unknown, ThreadAddress>; readonly owner: Event }> => {
  const calls: Array<{ readonly response: ActorMethodResponse; readonly link: Link<unknown, ThreadAddress>; readonly owner: Event }> = []
  for (const event of log) {
    const call = acceptedCallOf(event)
    if (call === undefined) continue
    for (const [name, method] of Object.entries(methods)) {
      if (call.invocation !== undefined && call.invocation.method !== name) continue
      const invocation = call.invocation ?? { method: name, id: call.id, epoch: 0 }
      const declaration = method as ActorMethodDeclaration
      const state = declaration.state(log, invocation)
      if (state === undefined || state.status === "pending") continue
      const response = responseOf(terminalOf(name, declaration, state), invocation)
      if (replyStateOf(log, { target: call.link.target, invocation }).status === "pending") calls.push({ response, link: call.link, owner: event })
      break
    }
  }
  return calls
}

const responseTransition = (response: ActorMethodResponse, link: Link<unknown, ThreadAddress>, owner: Event) =>
  bindTransitionContext(owner, "actor.responses").effect("deliver", {
      invocation: null,
      input: { response, link },
      act: ({ response: current, link: accepted }) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          yield* sendResponse(current, accepted, at)
          return {
            type: "ResponseDelivered",
            method: current.invocation.method,
            call: current.invocation.id,
            ...(current.invocation.epoch === 0 ? {} : { epoch: current.invocation.epoch }),
            at
          } satisfies ResponseDelivered
        })
    })

// methodResponseDerivation derives method reports from linked calls and their declared state projections.
export const methodResponseDerivation = (methods: ActorMethods): CompleteTransitionDerivation<Router | Self> => (log) =>
  linkedCalls(log.map((event, index) => eventAt(event, eventPositionOf(event) ?? index + 1)), methods)
    .slice(0, 1).map(({ response, link, owner }) => responseTransition(response, link, owner))

/** @deprecated Use methodResponseDerivation. This compatibility name describes a complete-history transition derivation. */
export const methodResponseReactor = (methods: ActorMethods): CompleteTransitionDerivation<Router | Self> =>
  methodResponseDerivation(methods)

export interface MethodResponseProjectionState {
  readonly calls: ReadonlyArray<AcceptedCall>
  readonly replies: ReadonlyMap<string, ReplyState>
}

// initialMethodResponseState constructs response delivery bookkeeping.
export const initialMethodResponseState = (): MethodResponseProjectionState => ({
  calls: [],
  replies: new Map()
})

// reduceMethodResponseState advances response delivery bookkeeping with one event.
export const reduceMethodResponseState = (
  state: MethodResponseProjectionState,
  event: Event
): MethodResponseProjectionState => {
  const replies = new Map(state.replies)
  const detached = invocationDetachedOf(event)
  if (detached?.direction === "incoming") {
    const key = invocationCoordinateKey(detached.reference)
    replies.set(key, reduceReplyState(replies.get(key) ?? { status: "pending" }, event, detached.reference))
  }
  if (event.type === "ResponseDelivered") {
    const response = event as ResponseDelivered
    const invocation = { method: response.method, id: response.call, epoch: response.epoch ?? 0 }
    for (const call of state.calls) {
      const reference = { target: call.link.target, invocation }
      const key = invocationCoordinateKey(reference)
      replies.set(key, reduceReplyState(replies.get(key) ?? { status: "pending" }, event, reference))
    }
  }
  const accepted = acceptedCallOf(event)
  return { calls: accepted === undefined ? state.calls : [...state.calls, accepted], replies }
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
      const reply = state.replies.get(invocationCoordinateKey({ target: call.link.target, invocation }))
      if (current === undefined || current.status === "pending" || (reply !== undefined && reply.status !== "pending")) continue
      const response = responseOf(terminalOf(name, method, current), invocation)
      return [responseTransition(response, call.link, call.owner)]
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
    name: "actor.responses",
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
