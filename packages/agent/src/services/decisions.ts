import { EffectExecution, ExecutionHandle, RuntimeError, durablePromise, type ActorCaller, Actor } from "@clavia/tardigrade-core"
import { Cause, Context, Effect, Exit, Layer, Schema } from "effect"
import { BudgetReply, ToolBudgetAmount } from "../contracts/budget"
import { BudgetDecision, Decision, type PermissionRequest } from "../contracts/events"
import { AskPermission, AskBudget } from "../contracts/acts"
import { tool } from "@clavia/tardigrade-libraries"

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
    const reply = yield* caller.request({
      requestId: request.callId, method: "budget",
      input: { reason: request.reason, metric: request.metric, amount: request.amount, used: request.used, limit: request.limit },
    })
    const decision = yield* Schema.decodeUnknownEffect(BudgetReply)(reply).pipe(Effect.mapError(RuntimeError.from))
    if (!decision.allowed) return { allowed: false, reason: decision.reason }
    return { allowed: true, additional: decision.amount }
  })),
})

export const askPermission = AskPermission.layer(input => Effect.gen(function* () {
  const answer = yield* PermissionRequests.use(service => service.request(input))
  const result = yield* Schema.decodeEffect(requestResult(Decision))(answer)
  return result.type === "decision" ? result.decision : AskPermission.defer({ ...result.handle, ...(result.mode ? { mode: result.mode } : {}) })
}).pipe(Effect.mapError(String)))

export const askBudget = AskBudget.layer(input => Effect.gen(function* () {
  const answer = yield* BudgetRequests.use(service => service.request(input))
  const result = yield* Schema.decodeEffect(requestResult(BudgetDecision))(answer)
  if (result.type === "pending") return AskBudget.defer({ ...result.handle, ...(result.mode ? { mode: result.mode } : {}) })
  if (result.decision.allowed) {
    const total = input.limit + result.decision.additional
    if (!Number.isFinite(total) || (input.metric === "toolCalls" && (!Number.isSafeInteger(result.decision.additional) || !Number.isSafeInteger(total)))) return yield* Effect.fail("Invalid budget grant")
  }
  return result.decision
}).pipe(Effect.mapError(String)))

export const grantBudget = tool({
  name: "grant_budget",
  description: "Grant additional tool calls to a child with an outstanding budget request. Use handle and requestId from its message. This grant does not consume tool budget.",
  input: Schema.Struct({ handle: ExecutionHandle, requestId: Schema.NonEmptyString, amount: ToolBudgetAmount }),
  run: ({ handle, requestId, amount }) => Effect.gen(function* () {
    const runtime = yield* Actor
    yield* runtime.reply(handle, requestId, { allowed: true, amount })
    return { handle, requestId, granted: amount }
  }),
})
