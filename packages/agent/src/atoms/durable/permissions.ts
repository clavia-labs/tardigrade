import { durableAtom, atom, tree, keyValue, RuntimeError } from "@clavia/tardigrade-core"
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
const PermissionCollections = Schema.Struct({ policy: tree(Schema.NullOr(PermissionPolicy)), decisions: keyValue(PermissionRecord), latest: keyValue(Schema.String) })
export const permissionRecords = durableAtom({
  name: "agent.permissions.decisions", input: Schema.Union([PermissionConfigured, PermissionUpdated, PermissionResolved]),
  schema: PermissionCollections, initial: { policy: null, decisions: {}, latest: {} },
  migrate: value => {
    if (Schema.is(PermissionCollections)(value)) return value
    const state = Schema.decodeUnknownSync(PermissionState)(value)
    return { policy: state.policy, decisions: Object.fromEntries(state.decisions.map((entry, index) => [`import:${index}`, entry])), latest: Object.fromEntries(state.decisions.map((entry, index) => [JSON.stringify([entry.action, entry.requestId]), `import:${index}`])) }
  },
  reduce: (state, event, _metadata, position) => {
    if (event.type !== "PermissionResolved") {
      const before = { policy: state.read(["policy"]), decisions: [] }, next = reducePermissions(before, event)
      return next === before ? state : state.set(["policy"], next.policy)
    }
    const key = JSON.stringify([event.action, event.requestId])
    const previous = state.has(["latest", key]) ? state.read(["decisions", state.read(["latest", key])]).decision : undefined
    if (previous?.allowed === event.decision.allowed && previous.reason === event.decision.reason) return state
    const id = `event:${position}`
    return state.batch(edit => {
      edit.set(["decisions", id], { action: event.action, requestId: event.requestId, decision: event.decision })
      edit.set(["latest", key], id)
    })
  },
})
export interface PermissionView {
  readonly policy: typeof PermissionPolicy.Type | null
  readonly decision: (action: typeof PermissionAction.Type, requestId: string) => typeof Decision.Type | undefined
}
export const permissionState = atom((get): PermissionView => {
  const state = get(permissionRecords)
  return {
    policy: state.read(["policy"]),
    decision: (action, requestId) => {
      const key = JSON.stringify([action, requestId])
      return state.has(["latest", key]) ? state.read(["decisions", state.read(["latest", key])]).decision : undefined
    },
  }
})
