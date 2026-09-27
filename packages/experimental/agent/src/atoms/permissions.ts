import { settledProjection } from "./settled-projection"
import { EffectExecution, RuntimeError } from "@clavia/tardigrade-experimental-core"
import { Effect, Schema } from "effect"
import { effectAtom, type Atom, eventValue, type EffectOutput } from "@clavia/tardigrade-experimental-core"
import { PermissionState, permissionState, type ToolState } from "../projections"
import { requestPromises } from "./requests"
import type { ToolSpec } from "@clavia/tardigrade-experimental-packages"
import { PermissionRequests, requestResult } from "../services/requests"
import { PermissionConfigured, PermissionUpdated, PermissionResolved, Decision, PermissionPolicy, type Event } from "../event"

type PermissionView<R> = EffectOutput<typeof PermissionState.Type & {
  readonly position: "configuring" | "ready" | "checking" | "waiting"
}, Event, Error, R>
export const DEFAULT_PERMISSION_POLICY: typeof PermissionPolicy.Type = { default: "ask", tools: {} }

// permissions records its initial policy and uses logged updates for subsequent calls.
export function permissions(pendingTools: Atom<typeof ToolState.Type>, options: { readonly policy?: typeof PermissionPolicy.Type; readonly tools?: Atom<EffectOutput<{ readonly specs: readonly ToolSpec[] }, unknown, unknown, unknown>> } = {}): Atom<PermissionView<PermissionRequests | EffectExecution>> {
  const initialPolicy = Schema.decodeSync(PermissionPolicy)(options.policy ?? DEFAULT_PERMISSION_POLICY)
  const decisions = settledProjection({ input: Schema.Union([PermissionConfigured, PermissionUpdated, PermissionResolved]), schema: PermissionState, initial: { policy: null, decisions: [] }, reduce: permissionState })
  return effectAtom(get => {
    const state = get(decisions)
    if (!state.policy) return {
      view: { ...state, position: "configuring" },
      effects: { permission: eventValue({ id: "configure", event: { type: "PermissionConfigured", policy: initialPolicy } satisfies Event }) },
    }
    const call = get(pendingTools).pending
    if (!call || state.decisions.some(value => value.callId === call.callId)) return { view: { ...state, position: "ready" }, effects: {} }
    if (get(requestPromises).some(item => item.type === "PermissionResolved" && item.callId === call.callId)) return { view: { ...state, position: "waiting" }, effects: {} }
    const metadata = options.tools ? get(options.tools).view.specs.find(tool => tool.name === call.name)?.metadata : undefined
    const mode = Object.hasOwn(state.policy.tools, call.name) ? state.policy.tools[call.name]!
      : metadata?.readOnly === true && state.policy.readOnly ? state.policy.readOnly : state.policy.default
    if (mode !== "ask") return {
      view: { ...state, position: "checking" },
      effects: { permission: eventValue({ id: `resolve:${call.callId}`, event: {
        type: "PermissionResolved", callId: call.callId, decision: { allowed: mode === "allow", reason: `Permission policy: ${mode}` },
      } satisfies Event }) },
    }
    return {
      view: { ...state, position: "checking" },
      effects: { permission: {
        kind: "effect" as const,
        id: call.callId,
        run: Effect.gen(function* () {
          const service = yield* PermissionRequests
          const answer = yield* service.request(call, metadata)
          const result = yield* Schema.decodeEffect(requestResult(Decision))(answer).pipe(Effect.mapError(RuntimeError.from))
          if (result.type === "decision") return { type: "PermissionResolved", callId: call.callId, decision: result.decision } as const
          const execution = yield* EffectExecution
          return { type: "PermissionResolved", callId: call.callId, promise: { ref: execution.ref, handle: result.handle, ...(result.mode ? { mode: result.mode } : {}) } } as const
        }).pipe(
          Effect.catch(error => Effect.succeed({ type: "PermissionResolved" as const, callId: call.callId, decision: { allowed: false, reason: `Permission request failed: ${error.message}` } })),
        ),
      } },
    }
  })
}
