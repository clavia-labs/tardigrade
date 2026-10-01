import { EffectExecution, ExecutionHandle, RuntimeError, durablePromise } from "@clavia/tardigrade-experimental-core"
import { Cause, Context, Effect, Exit, Layer, Schema } from "effect"
import type { ActorCaller } from "@clavia/tardigrade-experimental-host"
import type { BudgetDecision, Decision, PermissionRequest } from "../event"

export type RequestResult<Decision> =
  | { readonly type: "decision"; readonly decision: Decision }
  | { readonly type: "pending"; readonly handle: ExecutionHandle; readonly mode?: "poll" | "push" }

// requestResult validates immediate decisions and submitted handles before recording them.
export const requestResult = <Value>(decision: Schema.Schema<Value>) => Schema.Union([
  Schema.Struct({ type: Schema.Literal("decision"), decision: Schema.toType(decision) }),
  Schema.Struct({ type: Schema.Literal("pending"), handle: ExecutionHandle, mode: Schema.optionalKey(Schema.Literals(["poll", "push"])) }),
])

// deferDecision forks a local decision and returns its handle before the answer arrives.
export const deferDecision = <Value extends Schema.Json, Services>(work: Effect.Effect<Value, Error, Services>): Effect.Effect<RequestResult<Value>, Error, Services | EffectExecution> => Effect.gen(function* () {
  const execution = yield* EffectExecution
  const promise = durablePromise(execution.ref, { success: Schema.Json, error: Schema.String })
  const handle = yield* execution.fork(work.pipe(Effect.exit, Effect.map(exit => Exit.isSuccess(exit) ? promise.succeed(exit.value) : promise.fail(Cause.pretty(exit.cause)))))
  return { type: "pending", handle }
})

export class PermissionRequests extends Context.Service<PermissionRequests, {
  readonly request: (request: typeof PermissionRequest.Type) => Effect.Effect<RequestResult<typeof Decision.Type>, Error, EffectExecution>
}>()("example/PermissionRequests") {}

export type BudgetRequest = {
  readonly metric: string
  readonly callId: string
  readonly amount: number
  readonly reason: string
  readonly used: number
  readonly limit: number
}

export class BudgetRequests extends Context.Service<BudgetRequests, {
  readonly request: (request: BudgetRequest) => Effect.Effect<RequestResult<typeof BudgetDecision.Type>, Error, EffectExecution>
}>()("example/BudgetRequests") {}

// parentBudgetRequests translates a parent actor reply into a budget decision without changing actor state.
export const parentBudgetRequests = (caller: ActorCaller) => Layer.succeed(BudgetRequests, {
  request: request => deferDecision(Effect.gen(function* () {
    const decision = yield* caller.request({
      requestId: request.callId, kind: "budget", description: request.reason,
      input: { metric: request.metric, amount: request.amount, used: request.used, limit: request.limit },
    })
    if (!decision.allowed) return { allowed: false, reason: decision.reason }
    if (decision.amount === undefined) return yield* Effect.fail(new RuntimeError("Budget grant omitted its amount"))
    return { allowed: true, additional: decision.amount }
  })),
})
