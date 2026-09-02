import type { Event } from "@clavia/tardigrade-core/log/event"
import { HashMap, HashSet, Schema } from "effect"
import type { KeyFragment } from "@clavia/tardigrade-core/log"
import { intent, type Transition } from "@clavia/tardigrade-core/reconciliation"
import { externallyHandled, handles, incrementalComponent, type Component } from "@clavia/tardigrade-core/actor"
import { formatThreadAddress, isThreadAddress } from "@clavia/tardigrade-core/communication/endpoint"
import { PermissionDecision, requestPermissionMethod } from "../actor/permission"
import { permissionRequestDecided, permissionRequestFailed } from "../log/events"

export interface PermissionRequest {
  readonly id: string
  readonly request: string
  readonly turn: string
  readonly tool: string
  readonly action: string
  readonly resource?: string
  readonly reason: string
  readonly from?: string
  readonly grant: () => PermissionDecision
  readonly deny: (reason?: string) => PermissionDecision
}

export type DecidePermission = (request: PermissionRequest) => PermissionDecision

export interface PermissionAuthorityOptions {
  readonly decide: DecidePermission
}

export const permissionAuthorityKeys: KeyFragment = {
  prefixes: ["par:", "pa:"],
  keyOf: (event) => {
    const value = event as Record<string, unknown>
    if (event.type === "PermissionRequestReceived") return `par:${String(value.id)}`
    return event.type === "PermissionRequestDecided" || event.type === "PermissionRequestFailed"
      ? `pa:${String(value.callId)}`
      : undefined
  }
}

const failureMessage = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure)

type ReceivedPermissionRequest = Event & {
  readonly id?: unknown
  readonly request?: unknown
  readonly turn?: unknown
  readonly tool?: unknown
  readonly action?: unknown
  readonly resource?: unknown
  readonly reason?: unknown
  readonly link?: { readonly source?: unknown }
}

interface PermissionAuthorityState {
  readonly next: number
  readonly pending: HashMap.HashMap<string, { readonly order: number; readonly event: ReceivedPermissionRequest }>
  readonly settled: HashSet.HashSet<string>
}

const reduceAuthority = (state: PermissionAuthorityState, event: Event): PermissionAuthorityState => {
  if (event.type === "PermissionRequestDecided" || event.type === "PermissionRequestFailed") {
    const id = String((event as { readonly callId?: unknown }).callId ?? "")
    return {
      ...state,
      pending: HashMap.remove(state.pending, id),
      settled: HashSet.add(state.settled, id)
    }
  }
  if (event.type !== "PermissionRequestReceived") return state
  const received = event as ReceivedPermissionRequest
  const id = String(received.id ?? "")
  return HashSet.has(state.settled, id) || HashMap.has(state.pending, id)
    ? state
    : {
        ...state,
        next: state.next + 1,
        pending: HashMap.set(state.pending, id, { order: state.next, event: received })
      }
}

const authorityTransition = (
  received: ReceivedPermissionRequest | undefined,
  decide: DecidePermission
): Transition<never> | undefined => {
  if (received === undefined) return undefined

  const id = String(received.id ?? "")
  const request: PermissionRequest = {
    id,
    request: String(received.request ?? ""),
    turn: String(received.turn ?? ""),
    tool: String(received.tool ?? ""),
    action: String(received.action ?? ""),
    ...(typeof received.resource === "string" ? { resource: received.resource } : {}),
    reason: String(received.reason ?? ""),
    ...(isThreadAddress(received.link?.source) ? { from: formatThreadAddress(received.link.source) } : {}),
    grant: () => ({ granted: true }),
    deny: (reason) => ({ denied: true, ...(reason === undefined ? {} : { reason }) })
  }

  try {
    const decision = Schema.decodeSync(PermissionDecision)(decide(request))
    return intent({
      key: `pa:${id}`,
      input: { id, decision },
      events: (input, at) => [permissionRequestDecided({
        callId: input.id,
        granted: "granted" in input.decision,
        ...("denied" in input.decision && input.decision.reason !== undefined
          ? { reason: input.decision.reason }
          : {}),
        at
      })]
    })
  } catch (failure) {
    return intent({
      key: `pa:${id}`,
      input: { id, error: failureMessage(failure) },
      events: (input, at) => [permissionRequestFailed({ callId: input.id, error: input.error, at })]
    })
  }
}

const authorityComponent = (decide?: DecidePermission): Component<undefined> => {
  const component: Component<undefined> = incrementalComponent({
    name: "permission-authority",
    keys: permissionAuthorityKeys,
    initial: (): PermissionAuthorityState => ({ next: 0, pending: HashMap.empty(), settled: HashSet.empty() }),
    step: reduceAuthority,
    output: (state) => {
      if (decide === undefined) return { view: undefined, transitions: [] }
      const received = Array.from(HashMap.values(state.pending))
        .reduce((first, candidate) => first === undefined || candidate.order < first.order ? candidate : first, undefined as { readonly order: number; readonly event: ReceivedPermissionRequest } | undefined)
        ?.event
      const transition = authorityTransition(received, decide)
      return { view: undefined, transitions: transition === undefined ? [] : [transition] }
    }
  })
  return decide === undefined
    ? externallyHandled(requestPermissionMethod, component)
    : handles(requestPermissionMethod, component)
}

// permissionAuthority handles requestPermission with a pure local decision policy.
export const permissionAuthority = Object.assign(
  (options: PermissionAuthorityOptions): Component<undefined> => authorityComponent(options.decide),
  {
    // permissionAuthority.manual leaves requestPermission pending for an external decision.
    manual: (): Component<undefined> => authorityComponent()
  }
)
