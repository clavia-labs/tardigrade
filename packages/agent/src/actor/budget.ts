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
  incremental: {
    initial: (): BudgetMethodProjection => ({ received: new Set(), decided: new Map(), failed: new Map() }),
    reduce: (state, event): BudgetMethodProjection => {
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
    currentEpoch: () => 0,
    state: (state, invocation) => budgetStateFrom(state, invocation.id)
  },
  state: (events, invocation) => {
    const { id } = invocation
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
