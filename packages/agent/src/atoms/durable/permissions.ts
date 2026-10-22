import { durableAtom, RuntimeError } from "@clavia/tardigrade-core"
import { Schema } from "effect"
import { PermissionConfigured, PermissionUpdated, PermissionResolved, Decision, PermissionPolicy, PermissionAction, type Event } from "../../contracts/events"

export const PermissionState = Schema.Struct({ policy: Schema.NullOr(PermissionPolicy), decisions: Schema.Array(Schema.Struct({ action: PermissionAction, requestId: Schema.NonEmptyString, decision: Decision })) })
export function reducePermissions(state: typeof PermissionState.Type, event: Event): typeof PermissionState.Type {
  if (event.type === "PermissionConfigured") {
    if (state.policy) throw new RuntimeError("Permission policy is already configured")
    return { ...state, policy: event.policy }
  }
  if (event.type === "PermissionUpdated") {
    if (!state.policy) throw new RuntimeError("Permission policy is not configured")
    return { ...state, policy: event.policy }
  }
  if (event.type === "PermissionResolved") {
    const prior = state.decisions.findLast(value => value.action === event.action && value.requestId === event.requestId)?.decision
    if (prior?.allowed === event.decision.allowed && prior.reason === event.decision.reason) return state
    return { ...state, decisions: [...state.decisions, { action: event.action, requestId: event.requestId, decision: event.decision }] }
  }
  return state
}

export const permissionState = durableAtom({
  name: "agent.permissions.decisions",
  input: Schema.Union([PermissionConfigured, PermissionUpdated, PermissionResolved]),
  schema: PermissionState, initial: { policy: null, decisions: [] }, reduce: reducePermissions,
})
