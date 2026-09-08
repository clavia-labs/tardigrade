import { Schema } from "effect"
import { bindTransitionContext } from "../transition/transition"
import { eventAt, eventPositionOf } from "../event"
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
  name: string,
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
    return [bindTransitionContext(event, `actor.method-input.${name}`).intent("reject", (at) =>
      contract.reject(input, at), { invocation: null })]
  })
}

// methodInputValidationTransitions derive every durable input rejection owed by a method table.
export const methodInputValidationTransitions = (
  methods: ActorMethods,
  log: InvalidDurableMethodInput["log"]
) => {
  const events = log.map((event, index) => eventPositionOf(event) === undefined ? eventAt(event, index + 1) : event)
  return Object.entries(methods).flatMap(([name, method]) => transitionsFor(name, method, events))
}

// methodInputValidationComponents mount each method's durable input contract (packages/agent/src/runtime/composition.test.ts, "a historical model string durably fails its turn").
export const methodInputValidationComponents = (
  methods: ActorMethods
): ReadonlyArray<Component<undefined>> => Object.entries(methods).flatMap(([name, method]) => {
  if (method.durableInput === undefined) return []
  const projection = method.durableInput.projection
  return [projection === undefined
    ? legacyComponent({
        name: `actor.method-input.${name}`,
        derive: (log) => ({ view: undefined, transitions: transitionsFor(name, method, log) })
      })
    : component({
        name: `actor.method-input.${name}`,
        initial: projection.initial,
        step: projection.step,
        output: (state) => ({ view: undefined, transitions: projection.output(state) })
      })]
})
