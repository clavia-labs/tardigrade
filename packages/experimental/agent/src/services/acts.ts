import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { durablePromise, EffectExecution } from "@clavia/tardigrade-experimental-core"
import { Generate, Summarize, AskPermission, AskBudget } from "../acts"
import { ModelReply, Decision, BudgetDecision } from "../event"
import { Model } from "./model"
import { PermissionRequests, BudgetRequests, requestResult } from "./requests"

export const generate = Generate.layer(input => Effect.gen(function* () {
  const model = yield* Model
  const execution = yield* EffectExecution
  if (model.submit) return Generate.defer(yield* model.submit(input))
  const reply = durablePromise(execution.ref, { success: ModelReply, error: Schema.String })
  const handle = yield* execution.fork(model.call(input).pipe(
    Effect.exit,
    Effect.map(exit => Exit.isSuccess(exit) ? reply.succeed(exit.value) : reply.fail(Cause.pretty(exit.cause))),
  ))
  return Generate.defer(handle)
}).pipe(Effect.mapError(String)))

export const summarize = Summarize.layer(input => Model.use(model => model.call(input)).pipe(
  Effect.flatMap(reply => reply.text.trim() ? Effect.succeed(reply.text) : Effect.fail("Compaction returned an empty summary")),
  Effect.mapError(String),
))

export const askPermission = AskPermission.layer(input => Effect.gen(function* () {
  const answer = yield* PermissionRequests.use(service => service.request(input.call, input.metadata))
  const result = yield* Schema.decodeEffect(requestResult(Decision))(answer)
  return result.type === "decision" ? result.decision : AskPermission.defer({ ...result.handle, ...(result.mode ? { mode: result.mode } : {}) })
}).pipe(Effect.mapError(String)))

export const askBudget = AskBudget.layer(input => Effect.gen(function* () {
  const answer = yield* BudgetRequests.use(service => service.request(input))
  const result = yield* Schema.decodeEffect(requestResult(BudgetDecision))(answer)
  if (result.type === "pending") return AskBudget.defer({ ...result.handle, ...(result.mode ? { mode: result.mode } : {}) })
  if (result.decision.allowed && !Number.isSafeInteger(input.limit + result.decision.additionalCalls)) return yield* Effect.fail("Total tool budget exceeds safe integer range")
  return result.decision
}).pipe(Effect.mapError(String)))

export const modelActs = Layer.merge(generate, summarize)
