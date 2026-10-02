import { Schema } from "effect"

// InitialState maps destination durable atom names to encoded state.
export const InitialState = Schema.Record(Schema.String, Schema.Json).check(Schema.makeFilter(state => Object.keys(state).every(name => name.trim().length > 0), { title: "Initial state names are nonempty" }))
export type InitialState = typeof InitialState.Type

// StateInitialised supplies encoded durable atom state at the start of a journal.
export const StateInitialised = Schema.Struct({
  type: Schema.Literal("StateInitialised"),
  version: Schema.Literal(1),
  initialState: InitialState,
  source: Schema.optionalKey(Schema.Json),
})
export type StateInitialised = typeof StateInitialised.Type
