import { Schema } from "effect"
import { actorMethod } from "@clavia/tardigrade-core/actor/method"
import { budgetRequestReceived } from "../log/events"

const PositiveInteger = Schema.Int.pipe(
  Schema.check(Schema.makeFilter((value: number) => value > 0, { title: "positive" }))
)

export const BudgetRequestInput = Schema.Struct({
  request: Schema.String,
  turn: Schema.String,
  reason: Schema.String,
  amount: PositiveInteger
}).annotate({ identifier: "BudgetRequestInput" })

export type BudgetRequestInput = typeof BudgetRequestInput.Type

export const BudgetDecision = Schema.Union([
  Schema.Struct({ granted: PositiveInteger }),
  Schema.Struct({ denied: Schema.Literal(true), reason: Schema.optionalKey(Schema.String) })
]).annotate({ identifier: "BudgetDecision" })

export type BudgetDecision = typeof BudgetDecision.Type

// requestBudgetMethod exposes budget negotiation as a unary actor call.
export const requestBudgetMethod = actorMethod({
  input: BudgetRequestInput,
  output: BudgetDecision,
  event: ({ id, input, at }) => budgetRequestReceived({ id, ...input, at }),
  state: (events, id) => {
    const requested = events.some((event) =>
      event.type === "BudgetRequestReceived" && String((event as { readonly id?: unknown }).id) === id
    )
    if (!requested) return undefined
    const decided = events.find((event) =>
      event.type === "BudgetRequestDecided" && String((event as { readonly callId?: unknown }).callId) === id
    ) as { readonly grant?: unknown; readonly reason?: unknown } | undefined
    const failed = events.find((event) =>
      event.type === "BudgetRequestFailed" && String((event as { readonly callId?: unknown }).callId) === id
    ) as { readonly error?: unknown } | undefined
    if (failed !== undefined) return { status: "failed", error: String(failed.error ?? "budget authority failed") }
    if (decided === undefined) return { status: "pending" }
    const grant = Number(decided.grant ?? 0)
    return grant > 0
      ? { status: "completed", output: { granted: grant } }
      : {
          status: "completed",
          output: {
            denied: true as const,
            ...(typeof decided.reason === "string" && decided.reason !== "" ? { reason: decided.reason } : {})
          }
        }
  }
})
