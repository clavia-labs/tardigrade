import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { durablePromise, EffectExecution } from "@clavia/tardigrade-experimental-core"
import { Generate, Summarize, AskPermission, AskBudget } from "../acts"
import { ModelReply, Decision, BudgetDecision } from "../event"
import { Model } from "./model"
import { PermissionRequests, BudgetRequests, requestResult } from "./requests"

export const generate = Generate.layer(input => Effect.gen(function* () {
  const model = yield* Model
  const execution = yield* EffectExecution
  if (model.submit) return Generate.defer(yield* execution.submit(model.submit(input, execution)))
  const reply = durablePromise(execution.ref, { success: ModelReply, error: Schema.String })
  const handle = yield* execution.fork(model.call(input).pipe(
    Effect.exit,
    Effect.map(exit => Exit.isSuccess(exit) ? reply.succeed(exit.value) : reply.fail(Cause.pretty(exit.cause))),
  ))
  return Generate.defer(handle)
}).pipe(Effect.mapError(String)), { cancel: (input, context) => Model.use(model => model.cancel?.(input, context) ?? Effect.void) })

export const summarize = Summarize.layer(input => Model.use(model => model.call(input)).pipe(
  Effect.flatMap(reply => reply.text.trim() ? Effect.succeed(reply) : Effect.fail("Compaction returned an empty summary")),
  Effect.mapError(String),
))

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

export const modelActs = Layer.merge(generate, summarize)
