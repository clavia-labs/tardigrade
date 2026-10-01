import { durableAtom } from "@clavia/tardigrade-experimental-core"
import { Schema } from "effect"
import { PermissionConfigured, PermissionUpdated, PermissionResolved } from "../../event"
import { PermissionState, permissionState as reducePermissions } from "../../projections"

export const permissionState = durableAtom({
  name: "agent.permissions.decisions",
  input: Schema.Union([PermissionConfigured, PermissionUpdated, PermissionResolved]),
  schema: PermissionState, initial: { policy: null, decisions: [] }, reduce: reducePermissions,
})
