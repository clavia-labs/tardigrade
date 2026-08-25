import { Clock, Effect } from "effect"
import type { Event } from "../../log/event"
import type { KeyFragment } from "../../log"
import { Self, effect, type Reactor } from "../../reconciliation"
import { Router } from "../../communication/router"
import { boundaryEvent } from "../../communication/message"
import { envelopeOf } from "../../communication/envelope"
import { reverseLink, type Link } from "../../communication/link"
import {
  formatActorId,
  isActorId,
  isProviderEndpoint,
  type ActorId,
  type ProviderEndpoint
} from "../../communication/endpoint"
import type { ActorMethodDeclaration, ActorMethods } from "./definition"
import type { ActorMethodState } from "./state"
import type { Component } from "../component"

// ActorMethodResponse is one method state report correlated to its call.
export interface ActorMethodResponse<Output = unknown> {
  readonly method: string
  readonly call: string
  readonly revision: string
  readonly sequence: number
  readonly state: Exclude<ActorMethodState<Output>, { readonly status: "pending" }>
}

// MethodResponseReceived is a method response accepted into the caller's private log.
export interface MethodResponseReceived extends Event {
  readonly type: "MethodResponseReceived"
  readonly id: string
  readonly method: string
  readonly call: string
  readonly status: "blocked" | "completed" | "failed"
  readonly output?: unknown
  readonly error?: string
  readonly reason?: string
  readonly data?: unknown
  readonly from: string
  readonly at: number
}

// MethodResponseDelivered records that one report crossed its accepted call link.
export interface MethodResponseDelivered extends Event {
  readonly type: "MethodResponseDelivered"
  readonly method: string
  readonly call: string
  readonly revision: string
  readonly at: number
}

export const methodResponseKeys: KeyFragment = {
  prefixes: ["mres:", "mrecv:"],
  keyOf: (event) => {
    if (event.type === "MethodResponseDelivered") {
      return `mres:${String((event as { readonly method?: unknown }).method)}:${String((event as { readonly call?: unknown }).call)}:${String((event as { readonly revision?: unknown }).revision)}`
    }
    return event.type === "MethodResponseReceived"
      ? `mrecv:${String((event as { readonly id?: unknown }).id)}`
      : undefined
  }
}

const revisionOf = (state: Exclude<ActorMethodState<unknown>, { readonly status: "pending" }>): string =>
  state.status === "blocked" ? state.revision ?? `blocked:${state.reason}` : state.status

const sequenceOf = (state: Exclude<ActorMethodState<unknown>, { readonly status: "pending" }>): number =>
  state.sequence ?? 0

const textOf = (state: Exclude<ActorMethodState<unknown>, { readonly status: "pending" }>): string => {
  if (state.status === "failed") return `error: ${state.error}`
  if (state.status === "blocked") return state.reason
  return typeof state.output === "string" ? state.output : JSON.stringify(state.output)
}

const responseOf = (
  method: string,
  call: string,
  state: Exclude<ActorMethodState<unknown>, { readonly status: "pending" }>
): ActorMethodResponse => ({
  method,
  call,
  revision: revisionOf(state),
  sequence: sequenceOf(state),
  state
})

const delivered = (log: ReadonlyArray<Event>, response: ActorMethodResponse): boolean =>
  log.some((event) =>
    event.type === "MethodResponseDelivered" &&
    String((event as { readonly method?: unknown }).method) === response.method &&
    String((event as { readonly call?: unknown }).call) === response.call &&
    String((event as { readonly revision?: unknown }).revision) === response.revision
  )

const linkedCalls = (
  log: ReadonlyArray<Event>,
  methods: ActorMethods
): ReadonlyArray<{ readonly response: ActorMethodResponse; readonly link: Link<unknown, ActorId> }> => {
  const calls: Array<{ readonly response: ActorMethodResponse; readonly link: Link<unknown, ActorId> }> = []
  for (const event of log) {
    const candidate = event as { readonly id?: unknown; readonly call?: unknown; readonly link?: unknown }
    const invocation = typeof candidate.call === "object" && candidate.call !== null
      ? candidate.call as { readonly method?: unknown; readonly id?: unknown }
      : undefined
    const id = typeof invocation?.id === "string" ? invocation.id : candidate.id
    if (typeof id !== "string" || typeof candidate.link !== "object" || candidate.link === null) continue
    if (!("source" in candidate.link) || !("target" in candidate.link) || !isActorId(candidate.link.target)) continue
    for (const [name, method] of Object.entries(methods)) {
      if (invocation !== undefined && invocation.method !== name) continue
      const state = (method as ActorMethodDeclaration).state(log, id)
      if (state === undefined || state.status === "pending") continue
      const response = responseOf(name, id, state)
      if (!delivered(log, response)) calls.push({ response, link: candidate.link as Link<unknown, ActorId> })
      break
    }
  }
  return calls
}

// methodResponseReactor derives method reports from linked calls and their declared state projections.
export const methodResponseReactor = (methods: ActorMethods): Reactor<Router | Self> => (log) =>
  linkedCalls(log, methods).slice(0, 1).map(({ response, link }) =>
    effect({
      key: `mres:${response.method}:${response.call}:${response.revision}`,
      input: { response, link },
      act: ({ response: current, link: accepted }) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          const self = yield* Self
          const router = yield* Router
          const state = current.state
          const message = boundaryEvent({
            turn: current.call,
            round: current.sequence,
            text: textOf(state),
            outcome: state.status === "blocked" ? "requesting" : state.status,
            from: formatActorId(self),
            ...(state.data === undefined ? {} : { data: state.data }),
            at
          })
          if (isProviderEndpoint(accepted.source)) {
            yield* router.send(envelopeOf(
              reverseLink(accepted as Link<ProviderEndpoint, ActorId>),
              message
            ))
          } else if (isActorId(accepted.source)) {
            const responseEvent: MethodResponseReceived = {
              type: "MethodResponseReceived",
              id: message.id,
              method: current.method,
              call: current.call,
              status: state.status,
              ...(state.status === "completed" ? { output: state.output } : {}),
              ...(state.status === "failed" ? { error: state.error } : {}),
              ...(state.status === "blocked" ? {
                reason: state.reason
              } : {}),
              ...(state.data === undefined ? {} : { data: state.data }),
              from: formatActorId(self),
              at
            }
            yield* router.send(envelopeOf(
              reverseLink(accepted as Link<ActorId, ActorId>),
              responseEvent
            ))
          }
          return [{
            type: "MethodResponseDelivered",
            method: current.method,
            call: current.call,
            revision: current.revision,
            at
          } satisfies MethodResponseDelivered]
        })
    })
  )

// methodResponseComponent adapts declared method states into response transitions.
export const methodResponseComponent = (methods: ActorMethods): Component<undefined, Router | Self> => ({
  name: "actor.methods",
  keys: methodResponseKeys,
  derive: (log) => ({ view: undefined, transitions: methodResponseReactor(methods)(log) })
})
