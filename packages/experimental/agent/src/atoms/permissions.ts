import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { Effect, Schema } from "effect"
import { atom, type Atom, durableAtom, effectValue, eventValue, type EffectValue } from "@clavia/tardigrade-experimental-core"
import { PermissionState, permissionState, type ToolState } from "../projections"
import { PermissionRequests } from "../services/requests"
import { Decision, PermissionPolicy, type Event } from "../event"

type PermissionView<R> = typeof PermissionState.Type & {
  readonly position: "configuring" | "ready" | "checking" | "waiting"
  readonly effect?: EffectValue<Event, Error, R>
}
export const DEFAULT_PERMISSION_POLICY: typeof PermissionPolicy.Type = { default: "ask", tools: {} }

// permissions records its initial policy and uses logged updates for subsequent calls.
export function permissions(pendingTools: Atom<typeof ToolState.Type>, options: { readonly policy?: typeof PermissionPolicy.Type } = {}): Atom<PermissionView<PermissionRequests>> {
  const initialPolicy = Schema.decodeSync(PermissionPolicy)(options.policy ?? DEFAULT_PERMISSION_POLICY)
  const decisions = durableAtom({ schema: PermissionState, initial: { policy: null, requested: [], decisions: [] }, reduce: permissionState })
  return atom(get => {
    const state = get(decisions)
    if (!state.policy) return {
      ...state, position: "configuring",
      effect: eventValue({ id: "configure", event: { type: "PermissionConfigured", policy: initialPolicy } satisfies Event }),
    }
    const call = get(pendingTools).pending
    if (!call || state.decisions.some(value => value.callId === call.callId)) return { ...state, position: "ready" }
    const mode = Object.hasOwn(state.policy.tools, call.name) ? state.policy.tools[call.name]! : state.policy.default
    if (mode !== "ask") return {
      ...state, position: "ready",
      decisions: [...state.decisions, { callId: call.callId, decision: { allowed: mode === "allow", reason: `Permission policy: ${mode}` } }],
    }
    if (state.requested.includes(call.callId)) return { ...state, position: "waiting" }
    return {
      ...state, position: "checking",
      effect: effectValue({
        id: call.callId,
        request: { type: "PermissionRequested" as const, callId: call.callId },
        run: Effect.gen(function* () {
          const service = yield* PermissionRequests
          const answer = yield* service.request(call)
          return yield* Schema.decodeEffect(Decision)(answer).pipe(Effect.mapError(RuntimeError.from))
        }).pipe(
          Effect.catch(error => Effect.succeed({ allowed: false, reason: `Permission request failed: ${error.message}` })),
          Effect.map(decision => ({ type: "PermissionResolved" as const, callId: call.callId, decision })),
        ),
      }),
    }
  })
}
