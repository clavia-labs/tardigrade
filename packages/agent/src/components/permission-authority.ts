import type { Event } from "@clavia/tardigrade-core/log/event"
import { Schema } from "effect"
import type { KeyFragment } from "@clavia/tardigrade-core/log"
import { intent, type Transition } from "@clavia/tardigrade-core/reconciliation"
import { externallyHandled, handles, type Component } from "@clavia/tardigrade-core/actor"
import { formatActorId, isActorId } from "@clavia/tardigrade-core/communication/endpoint"
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

const authorityTransition = (
  log: ReadonlyArray<Event>,
  decide: DecidePermission
): Transition<never> | undefined => {
  const received = log.find((event) =>
    event.type === "PermissionRequestReceived" &&
    !log.some((terminal) =>
      (terminal.type === "PermissionRequestDecided" || terminal.type === "PermissionRequestFailed") &&
      String((terminal as { readonly callId?: unknown }).callId) === String((event as { readonly id?: unknown }).id)
    )
  ) as {
    readonly id?: unknown
    readonly request?: unknown
    readonly turn?: unknown
    readonly tool?: unknown
    readonly action?: unknown
    readonly resource?: unknown
    readonly reason?: unknown
    readonly link?: { readonly source?: unknown }
  } | undefined
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
    ...(isActorId(received.link?.source) ? { from: formatActorId(received.link.source) } : {}),
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
  const component: Component<undefined> = {
    name: "permission-authority",
    keys: permissionAuthorityKeys,
    derive: (log) => {
      if (decide === undefined) return { view: undefined, transitions: [] }
      const transition = authorityTransition(log, decide)
      return { view: undefined, transitions: transition === undefined ? [] : [transition] }
    }
  }
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
