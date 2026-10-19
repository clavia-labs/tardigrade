import { durableAtom, atom, RuntimeError } from "@clavia/tardigrade-core"
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

const PermissionRecord = Schema.Struct({ action: PermissionAction, requestId: Schema.NonEmptyString, decision: Decision })
const PermissionCollections = Schema.Struct({ policy: Schema.NullOr(PermissionPolicy), decisions: Schema.Record(Schema.String, PermissionRecord), latest: Schema.Record(Schema.String, Schema.String) })
export const permissionRecords = durableAtom({
  name: "agent.permissions.decisions", input: Schema.Union([PermissionConfigured, PermissionUpdated, PermissionResolved]),
  schema: PermissionState, initial: { policy: null, decisions: [] },
  migrate: stored => {
    if (Schema.is(PermissionState)(stored)) return stored
    const state = Schema.decodeUnknownSync(PermissionCollections)(stored)
    const latest = new Set(Object.values(state.latest)), entries = Object.entries(state.decisions)
    return { policy: state.policy, decisions: [...entries.filter(([id]) => !latest.has(id)), ...entries.filter(([id]) => latest.has(id))].map(([, entry]) => entry) }
  },
  reduce: reducePermissions,
})

export interface PermissionView {
  readonly policy: typeof PermissionPolicy.Type | null
  readonly decision: (action: typeof PermissionAction.Type, requestId: string) => typeof Decision.Type | undefined
}
export const permissionState = atom((get): PermissionView => {
  const state = get(permissionRecords)
  return {
    policy: state.policy,
    decision: (action, requestId) => state.decisions.findLast(entry => entry.action === action && entry.requestId === requestId)?.decision,
  }
})
