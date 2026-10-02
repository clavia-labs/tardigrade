import { Schema } from "effect"

// InitialState maps destination durable atom names to encoded state.
export const InitialState = Schema.Record(Schema.String, Schema.Json).check(Schema.makeFilter(state => Object.keys(state).every(name => name.trim().length > 0), { title: "Initial state names are nonempty" }))
export type InitialState = typeof InitialState.Type

// StateInitialised supplies encoded durable atom state at the start of a journal.
export const StateInitialised = Schema.Struct({
  type: Schema.Literal("StateInitialised"),
  version: Schema.Literal(1),
  durable: Schema.Array(Schema.Struct({ name: Schema.NonEmptyString, state: Schema.Json })),
  source: Schema.optionalKey(Schema.Json),
}).check(Schema.makeFilter(event => {
  const names = event.durable.map(entry => entry.name)
  return names.every(name => name.trim().length > 0) && new Set(names).size === names.length
}, { title: "Initialised durable atom names are nonempty and unique" }))
export type StateInitialised = typeof StateInitialised.Type
