import type { ReadonlyLog } from "./runtime/log-view"
import { Schema } from "effect"
import type { Getter } from "./atoms/atom"
import type { Recorded } from "./services/journal"
import { ThreadCreated } from "./actor/thread"

export const AtomState = Symbol("AtomState")

export interface StatefulAtom {
  readonly [AtomState]: {
    readonly name: string
    readonly decode: (state: unknown) => unknown
    readonly encode: (get: Getter) => unknown
  }
}

export interface StateSeed {
  readonly position: number
  readonly state: ReadonlyMap<string, unknown>
}

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

// initialStateSeed resolves checkpoint state or a fresh journal marker into an atom seed.
export function initialStateSeed(records: ReadonlyLog<Recorded<unknown>>, checkpoint?: { readonly position: number; readonly durable: readonly { readonly name: string; readonly state: unknown }[] }): StateSeed | undefined {
  if (checkpoint) return { position: checkpoint.position, state: new Map(checkpoint.durable.map(entry => [entry.name, entry.state] as const)) }
  const first = records.at(0)?.event
  const index = Schema.is(ThreadCreated)(first) ? 1 : 0
  const event = records.at(index)?.event
  return Schema.is(StateInitialised)(event) ? { position: index + 1, state: new Map(Object.entries(event.initialState)) } : undefined
}
