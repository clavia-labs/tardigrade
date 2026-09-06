import { Schema } from "effect"
import { intent } from "@clavia/tardigrade-core/intent"
import { component, legacyComponent, type Component } from "@clavia/tardigrade-core/component"
import type { ActorMethods, InvalidDurableMethodInput } from "./method"

const errorOf = (
  schema: Schema.ConstraintDecoder<unknown>,
  value: unknown
): string | undefined => {
  try {
    Schema.decodeUnknownSync(schema)(value)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const transitionsFor = (
  method: ActorMethods[string],
  log: InvalidDurableMethodInput["log"]
) => {
  const contract = method.durableInput
  if (contract === undefined) return []
  return log.flatMap((event, index) => {
    if (!contract.matches(event)) return []
    const error = errorOf(contract.schema, event)
    if (error === undefined) return []
    const input: InvalidDurableMethodInput = { event, index, log, error }
    return [intent({
      key: contract.keyOf(input),
      input,
      events: (current, at) => [contract.reject(current, at)]
    })]
  })
}

// methodInputValidationTransitions derive every durable input rejection owed by a method table.
export const methodInputValidationTransitions = (
  methods: ActorMethods,
  log: InvalidDurableMethodInput["log"]
) => Object.values(methods).flatMap((method) => transitionsFor(method, log))

// methodInputValidationComponents mount each method's durable input contract (packages/agent/src/runtime/composition.test.ts, "a historical model string durably fails its turn").
export const methodInputValidationComponents = (
  methods: ActorMethods
): ReadonlyArray<Component<undefined>> => Object.entries(methods).flatMap(([name, method]) => {
  if (method.durableInput === undefined) return []
  const projection = method.durableInput.projection
  return [projection === undefined
    ? legacyComponent({
        name: `actor.method-input.${name}`,
        derive: (log) => ({ view: undefined, transitions: transitionsFor(method, log) })
      })
    : component({
        name: `actor.method-input.${name}`,
        initial: projection.initial,
        step: projection.step,
        output: (state) => ({ view: undefined, transitions: projection.output(state) })
      })]
})
