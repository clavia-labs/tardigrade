import { Schema } from "effect"
import { durableAtom, event } from "@clavia/tardigrade-core"

// completionState folds callback domain events into durable fixture state (test/properties/runtime/cancellation.ts).
export function completionState<const Name extends string, Value extends Schema.Json>(name: Name, success: Schema.Schema<Value>) {
  const Outcome = Schema.Union([
    Schema.Struct({ status: Schema.Literal("fulfilled"), value: success }),
    Schema.Struct({ status: Schema.Literal("rejected"), reason: Schema.Json }),
  ])
  const Settled = event({ type: `${name}.Settled`, outcome: Outcome })
  const state = durableAtom({ name, input: Settled, schema: Schema.Union([Schema.Struct({ status: Schema.Literal("pending") }), Outcome]),
    initial: { status: "pending" }, reduce: (_, entry) => entry.outcome,
  })
  return { event: Settled, state, onSettled: (outcome: typeof Outcome.Type) => [Settled.make({ outcome })] }
}
