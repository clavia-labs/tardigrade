import { Clock, Effect, Schema } from "effect"
import type { Event } from "../../log/event"
import type { KeyFragment } from "../../log"
import { Self, effect, type Reactor } from "../../reconciliation"
import { Router } from "../../communication/router"
import { boundaryEvent } from "../../communication/message"
import { envelopeOf } from "../../communication/envelope"
import { reverseLink, type Link } from "../../communication/link"
import {
  formatThreadAddress,
  isThreadAddress,
  isProviderEndpoint,
  type ThreadAddress,
  type ProviderEndpoint
} from "../../communication/endpoint"
import type { ActorMethodDeclaration, ActorMethods } from "./definition"
import type { ActorMethodState } from "./state"
import type { Component } from "../component"

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
    const candidate = event as { readonly id?: unknown; readonly call?: unknown; readonly link?: unknown }
    const context = typeof candidate.call === "object" && candidate.call !== null
      ? candidate.call as { readonly invocation?: unknown }
      : undefined
    const invocation = typeof context?.invocation === "object" && context.invocation !== null
      ? context.invocation as { readonly method?: unknown; readonly id?: unknown; readonly epoch?: unknown }
      : undefined
    const id = typeof invocation?.id === "string" ? invocation.id : candidate.id
    if (typeof id !== "string" || typeof candidate.link !== "object" || candidate.link === null) continue
    if (!("source" in candidate.link) || !("target" in candidate.link) || !isThreadAddress(candidate.link.target)) continue
    for (const [name, method] of Object.entries(methods)) {
      if (invocation !== undefined && invocation.method !== name) continue
      const declaration = method as ActorMethodDeclaration
      const state = declaration.state(log, {
        method: name,
        id,
        epoch: typeof invocation?.epoch === "number" ? invocation.epoch : 0
      })
      if (state === undefined || state.status === "pending") continue
      const response = responseOf(name, id, terminalOf(name, declaration, state))
      if (!delivered(log, response)) calls.push({ response, link: candidate.link as Link<unknown, ThreadAddress> })
      break
    }
  }
  return calls
}

// methodResponseReactor derives method reports from linked calls and their declared state projections.
export const methodResponseReactor = (methods: ActorMethods): Reactor<Router | Self> => (log) =>
  linkedCalls(log, methods).slice(0, 1).map(({ response, link }) =>
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
  )

// methodResponseComponent adapts declared method states into response transitions.
export const methodResponseComponent = (methods: ActorMethods): Component<undefined, Router | Self> => ({
  name: "actor.methods",
  keys: methodResponseKeys,
  derive: (log) => ({ view: undefined, transitions: methodResponseReactor(methods)(log) })
})
