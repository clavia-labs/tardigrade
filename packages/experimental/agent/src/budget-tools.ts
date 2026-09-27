import { Actor } from "@clavia/tardigrade-experimental-host"
import { ExecutionHandle } from "@clavia/tardigrade-experimental-core"
import { Effect, Schema } from "effect"
import { tool } from "@clavia/tardigrade-experimental-packages"

const Amount = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

export const BudgetRequestInput = Schema.Struct({ amount: Amount, reason: Schema.NonEmptyString })

export const requestBudget = {
  spec: {
    name: "request_budget",
    description: "Request additional tool calls when your budget is exhausted. Waits for a decision and consumes no tool budget.",
    inputSchema: Schema.toJsonSchemaDocument(BudgetRequestInput).schema,
    execution: "sync" as const,
  },
}

export const grantBudget = tool({
  name: "grant_budget",
  description: "Grant additional tool calls to a child with an outstanding budget request. Use handle and requestId from its message. This grant does not consume tool budget.",
  input: Schema.Struct({ handle: ExecutionHandle, requestId: Schema.NonEmptyString, amount: Amount }),
  run: ({ handle, requestId, amount }) => Effect.gen(function* () {
    const runtime = yield* Actor
    yield* runtime.reply(handle, requestId, { allowed: true, amount })
    return { handle, requestId, granted: amount }
  }),
})
