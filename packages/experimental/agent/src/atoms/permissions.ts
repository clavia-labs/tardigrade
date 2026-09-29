import type { ActService } from "@clavia/tardigrade-experimental-core"
import { AskPermission, requests } from "../acts"
import { durableAtom } from "@clavia/tardigrade-experimental-core"
import { Schema } from "effect"
import { atom, effectAtom, type Atom, eventValue, type EffectOutput } from "@clavia/tardigrade-experimental-core"
import { PermissionState, permissionState, type ToolState } from "../projections"
import type { ToolSpec } from "@clavia/tardigrade-experimental-packages/types"
import { PermissionConfigured, PermissionUpdated, PermissionResolved, PermissionPolicy, type Event } from "../event"

type PermissionView<R> = EffectOutput<typeof PermissionState.Type & {
  readonly position: "configuring" | "ready" | "checking" | "waiting"
}, Event, R>
export const DEFAULT_PERMISSION_POLICY: typeof PermissionPolicy.Type = { default: "ask", tools: {} }

// permissions records its initial policy and uses logged updates for subsequent calls.
export function permissions(pendingTools: Atom<typeof ToolState.Type>, options: { readonly policy?: typeof PermissionPolicy.Type; readonly tools?: Atom<EffectOutput<{ readonly specs: readonly ToolSpec[] }, unknown, unknown>> } = {}): Atom<PermissionView<ActService<"agent.permission.request">>> {
  const initialPolicy = Schema.decodeSync(PermissionPolicy)(options.policy ?? DEFAULT_PERMISSION_POLICY)
  const decisions = durableAtom({ input: Schema.Union([PermissionConfigured, PermissionUpdated, PermissionResolved]), schema: PermissionState, initial: { policy: null, decisions: [] }, reduce: permissionState })
  const request = requests(AskPermission.request)
  return effectAtom(get => {
    const state = get(decisions)
    if (!state.policy) return {
      view: { ...state, position: "configuring" },
      effects: { permission: eventValue({ type: "PermissionConfigured", policy: initialPolicy } satisfies Event) },
    }
    const call = get(pendingTools).pending
    if (!call || state.decisions.some(value => value.callId === call.callId)) return { view: { ...state, position: "ready" }, effects: {} }
    const metadata = options.tools ? get(options.tools).view.specs.find(tool => tool.name === call.name)?.metadata : undefined
    const mode = Object.hasOwn(state.policy.tools, call.name) ? state.policy.tools[call.name]!
      : metadata?.readOnly === true && state.policy.readOnly ? state.policy.readOnly : state.policy.default
    if (mode !== "ask") return {
      view: { ...state, position: "checking" },
      effects: { permission: eventValue({
        type: "PermissionResolved", callId: call.callId, decision: { allowed: mode === "allow", reason: `Permission policy: ${mode}` },
      } satisfies Event) },
    }
    return {
      view: { ...state, position: "checking" },
      effects: { permission: request({
        tag: call.callId,
        input: { call, ...(metadata ? { metadata } : {}) },
        onSettled: result => [{ type: "PermissionResolved", callId: call.callId, decision: result.status === "fulfilled"
          ? result.value : { allowed: false, reason: `Permission request failed: ${result.reason}` } } satisfies Event],
      }) },
    }
  })
}

// permissionInstructions describes the recorded permission policy for model input.
export const permissionInstructions = <R>(permission: Atom<PermissionView<R>>) => atom(get => {
  const { policy } = get(permission).view
  return policy === null ? "" : `Tool permission policy: ${JSON.stringify(policy)}. Denied calls must be respected.`
})
