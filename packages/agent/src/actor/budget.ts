import { Schema } from "effect"
import { actorMethod } from "@clavia/tardigrade-core/method"
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

interface BudgetMethodProjection {
  readonly received: ReadonlySet<string>
  readonly decided: ReadonlyMap<string, { readonly grant?: unknown; readonly reason?: unknown }>
  readonly failed: ReadonlyMap<string, string>
}

const budgetStateFrom = (state: BudgetMethodProjection, id: string) => {
  if (!state.received.has(id)) return undefined
  const failure = state.failed.get(id)
  if (failure !== undefined) return { status: "failed" as const, error: failure }
  const decision = state.decided.get(id)
  if (decision === undefined) return { status: "pending" as const }
  const grant = Number(decision.grant ?? 0)
  return grant > 0
    ? { status: "completed" as const, output: { granted: grant } }
    : {
        status: "completed" as const,
        output: {
          denied: true as const,
          ...(typeof decision.reason === "string" && decision.reason !== "" ? { reason: decision.reason } : {})
        }
      }
}

// requestBudgetMethod exposes budget negotiation as a unary actor call.
export const requestBudgetMethod = actorMethod({
  input: BudgetRequestInput,
  output: BudgetDecision,
  event: ({ invocation, input, at }) => budgetRequestReceived({ id: invocation.id, ...input, at }),
  projection: {
    initial: (): BudgetMethodProjection => ({ received: new Set(), decided: new Map(), failed: new Map() }),
    step: (state, event): BudgetMethodProjection => {
      const received = new Set(state.received)
      const decided = new Map(state.decided)
      const failed = new Map(state.failed)
      if (event.type === "BudgetRequestReceived") {
        received.add(String((event as { readonly id?: unknown }).id ?? ""))
      }
      if (event.type === "BudgetRequestDecided") {
        decided.set(
          String((event as { readonly callId?: unknown }).callId ?? ""),
          event as { readonly grant?: unknown; readonly reason?: unknown }
        )
      }
      if (event.type === "BudgetRequestFailed") {
        failed.set(
          String((event as { readonly callId?: unknown }).callId ?? ""),
          String((event as { readonly error?: unknown }).error ?? "budget authority failed")
        )
      }
      return { received, decided, failed }
    },
    output: (state) => ({
      currentEpoch: () => 0,
      invocationState: (invocation) => budgetStateFrom(state, invocation.id)
    })
  }
})
