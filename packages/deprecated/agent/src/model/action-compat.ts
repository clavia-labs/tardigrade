import type { Action, ToolCall } from "../log/events"

/** @deprecated Return Action with kind: "calls" instead. */
export type LegacyCallAction = Omit<Extract<Action, { readonly kind: "calls" }>, "kind" | "calls"> & ToolCall & { readonly kind: "call" }

// normalizeAction confines legacy single-call responses to the inference boundary.
// TODO: Remove legacy call support in the next breaking release.
export const normalizeAction = (action: Action | LegacyCallAction): Action => {
  if (action.kind !== "call") return action
  const { callId, name, arguments: args, kind: _kind, ...response } = action
  return { ...response, kind: "calls", calls: [{ callId, name, arguments: args }] }
}
