import { bindValue, ValueState, type Json } from "@tardie/grove"
import { Schema } from "effect"
import type { RecordMetadata } from "../../services/journal"
import { DocumentState } from "../../services/tree-state"
import { durableProjection } from "./projection"

// wholeValueAtom folds events into Grove-owned inline values (properties/collections.test.ts).
export function wholeValueAtom<State extends Json, Event>(options: {
  readonly name: string
  readonly schema: Schema.Schema<State>
  readonly input: Schema.Schema<Event>
  readonly initial: NoInfer<State>
  readonly reduce: (state: NoInfer<State>, event: NoInfer<Event>, metadata: RecordMetadata, position: number) => NoInfer<State>
}) {
  const binding = bindValue(options.schema)
  const initial = binding.initial(options.initial)
  const decode = (stored: unknown) => Schema.is(ValueState)(stored) ? binding.restore(stored) : binding.check(stored)
  return durableProjection(options, {
    initial: () => initial,
    check: binding.check,
    restore: (stored, service) => {
      if (Schema.is(ValueState)(stored)) return binding.restore(stored)
      if (!Schema.is(DocumentState)(stored)) return binding.check(stored)
      if (!service.documents) throw new Error(`Durable atom "${options.name}" requires documents to restore its stored checkpoint`)
      return binding.check(service.documents.read(stored.reference))
    },
    state: { name: options.name, decode, encode: binding.encode },
  })
}
