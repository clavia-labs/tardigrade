import type { ActService } from "@clavia/tardigrade-experimental-core"
import { AskPermission, requests, failureMessage } from "../acts"
import { permissionState } from "./durable/permissions"
import { Schema } from "effect"
import { effectAtom, type Atom, eventValue, type ActorOutput } from "@clavia/tardigrade-experimental-core"
import { PermissionState, type ToolState } from "../projections"
import type { ToolSpec } from "@clavia/tardigrade-experimental-packages/types"
import { PermissionPolicy, type Event } from "../event"

type PermissionView<R> = ActorOutput<typeof PermissionState.Type & {
  readonly position: "configuring" | "ready" | "checking" | "waiting"
}, Event, R>
export const DEFAULT_PERMISSION_POLICY: typeof PermissionPolicy.Type = { default: "ask", actions: {} }

// permissions records its initial policy and uses logged updates for subsequent calls.
export function permissions(pendingTools: Atom<typeof ToolState.Type>, options: { readonly policy?: typeof PermissionPolicy.Type; readonly tools?: Atom<ActorOutput<{ readonly specs: readonly ToolSpec[] }, unknown, unknown>> } = {}): Atom<PermissionView<ActService<"agent.permission.request">>> {
  const initialPolicy = Schema.decodeSync(PermissionPolicy)(options.policy ?? DEFAULT_PERMISSION_POLICY)
  const request = requests(AskPermission.request)
  return effectAtom(get => {
    const state = get(permissionState)
    if (!state.policy) return {
      view: { ...state, position: "configuring" },
      acts: {}, events: { permission: eventValue({ type: "PermissionConfigured", policy: initialPolicy } satisfies Event) },
    }
    const call = get(pendingTools).pending
    if (!call || state.decisions.some(value => value.action === "tool.execute" && value.requestId === call.callId)) return { view: { ...state, position: "ready" }, events: {}, acts: {} }
    const metadata = options.tools ? get(options.tools).view.specs.find(tool => tool.name === call.name)?.metadata : undefined
    const rule = Object.hasOwn(state.policy.actions, "tool.execute") ? state.policy.actions["tool.execute"] : undefined
    const mode = rule && Object.hasOwn(rule.resources, call.name) ? rule.resources[call.name]!
      : metadata?.readOnly === true && rule?.readOnly ? rule.readOnly : rule?.default ?? state.policy.default
    if (mode !== "ask") return {
      view: { ...state, position: "checking" },
      acts: {}, events: { permission: eventValue({
        type: "PermissionResolved", action: "tool.execute", requestId: call.callId, decision: { allowed: mode === "allow", reason: `Permission policy: ${mode}` },
      } satisfies Event) },
    }
    return {
      view: { ...state, position: "checking" },
      events: {}, acts: { permission: request({
        tag: JSON.stringify(["tool.execute", call.callId]),
        input: { action: "tool.execute", requestId: call.callId, resource: call.name, input: call.input, ...(metadata ? { metadata } : {}) },
        onSettled: result => [{ type: "PermissionResolved", action: "tool.execute", requestId: call.callId, decision: result.status === "fulfilled"
          ? result.value : { allowed: false, reason: `Permission request failed: ${failureMessage(result.reason)}` } } satisfies Event],
      }) },
    }
  })
}
