import { Schema } from "effect"
import type { Router } from "@clavia/tardigrade-core/transport/router"
import type { Self } from "@clavia/tardigrade-core/runtime"
import type { KeyFragment } from "@clavia/tardigrade-core/log"
import { PermissionDecision, requestPermissionMethod, type PermissionRequestInput } from "../../actor/permission"
import { permissionRequestDecided, permissionRequestFailed } from "../../log/events"
import { authorityComponent, type AuthorityComponent } from "./authority"
import type { AuthorityTarget } from "./target"

export interface PermissionRequest extends PermissionRequestInput {
  readonly id: string
  readonly from?: string
  readonly grant: () => PermissionDecision
  readonly deny: (reason?: string) => PermissionDecision
}
export type DecidePermission = (request: PermissionRequest) => PermissionDecision
export type PermissionAuthorityMethods = { readonly requestPermission: typeof requestPermissionMethod }
export type PermissionAuthority = AuthorityTarget<PermissionAuthorityMethods>
export type PermissionAuthorityOptions =
  | { readonly decide: DecidePermission; readonly delegate?: never }
  | { readonly delegate: PermissionAuthority; readonly decide?: never }

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

const definition = {
  name: "permission-authority",
  methods: { requestPermission: requestPermissionMethod },
  method: "requestPermission" as const,
  received: "PermissionRequestReceived",
  decided: "PermissionRequestDecided",
  failed: "PermissionRequestFailed",
  keys: permissionAuthorityKeys,
  input: (event: import("@clavia/tardigrade-core/event").Event): PermissionRequestInput => ({
    request: String(event.request ?? ""),
    turn: String(event.turn ?? ""),
    reason: String(event.reason ?? ""),
    action: String(event.action ?? ""),
    ...(typeof event.resource === "string" ? { resource: event.resource } : {})
  }),
  request: ({
    id,
    input,
    from
  }: import("./authority").AuthorityRequest<PermissionRequestInput>): PermissionRequest => ({
    ...input,
    id,
    ...(from === undefined ? {} : { from }),
    grant: () => ({ granted: true }),
    deny: (reason) => ({ denied: true, ...(reason === undefined ? {} : { reason }) })
  }),
  decision: (id: string, proposed: PermissionDecision, at: number) => {
    const decision = Schema.decodeSync(PermissionDecision)(proposed)
    return permissionRequestDecided({
      callId: id,
      granted: "granted" in decision,
      ...("denied" in decision && decision.reason !== undefined ? { reason: decision.reason } : {}),
      at
    })
  },
  failure: (id: string, error: string, at: number) => permissionRequestFailed({ callId: id, error, at })
}

function create(options: {
  readonly delegate: PermissionAuthority
  readonly decide?: never
}): AuthorityComponent<PermissionRequestInput, PermissionDecision, Router | Self>
function create(options: {
  readonly decide: DecidePermission
  readonly delegate?: never
}): AuthorityComponent<PermissionRequestInput, PermissionDecision>
function create(
  options: PermissionAuthorityOptions
): AuthorityComponent<PermissionRequestInput, PermissionDecision, Router | Self> {
  return options.delegate === undefined
    ? authorityComponent(definition, { decide: options.decide })
    : authorityComponent(definition, { delegate: options.delegate })
}

// permissionAuthority handles incoming permission requests locally, by delegation, or through manual decisions (authority.test.ts).
export const permissionAuthority = Object.assign(create, {
  manual: (): AuthorityComponent<PermissionRequestInput, PermissionDecision> => authorityComponent(definition)
})
