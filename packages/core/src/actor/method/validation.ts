import { Schema } from "effect"
import { intent } from "../../reconciliation"
import type { Component } from "../component"
import type { ActorMethods, InvalidDurableMethodInput } from "./definition"

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
  return [{
    name: `actor.method-input.${name}`,
    derive: (log) => ({
      view: undefined,
      transitions: transitionsFor(method, log)
    })
  }]
})
