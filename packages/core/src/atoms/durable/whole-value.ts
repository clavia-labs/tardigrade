import { bindValue, type Json } from "@tardie/grove"
import type { Schema } from "effect"
import * as migrations from "@tardie/grove/migrations"
import type { RecordMetadata } from "../../services/journal"
import { durableProjection } from "./projection"

// wholeValueAtom folds events into Grove-owned inline values (properties/collections.test.ts).
export function wholeValueAtom<State extends Json, Event>(options: {
  readonly name: string
  readonly schema: Schema.Schema<State>
  readonly input: Schema.Schema<Event>
  readonly migrate?: (stored: unknown) => unknown
  readonly initial: NoInfer<State>
  readonly reduce: (state: NoInfer<State>, event: NoInfer<Event>, metadata: RecordMetadata, position: number) => NoInfer<State>
}) {
  const binding = bindValue(options.schema)
  const initial = binding.initial(options.initial)
  const prepare = (stored: unknown) => binding.check(options.migrate ? options.migrate(stored) : stored)
  const decode = (stored: unknown) => prepare(migrations.read(stored, () => { throw new Error("Inline codec cannot load a stored reference") }))
  return durableProjection(options, {
    initial: () => initial,
    check: binding.check,
    restore: (stored, service) => prepare(migrations.read(stored, reference => {
      if (!service.documents) throw new Error(`Durable atom "${options.name}" requires documents to restore its stored checkpoint`)
      return service.documents.read(reference)
    })),
    state: { name: options.name, decode, encode: binding.encode },
  })
}
