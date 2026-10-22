import { Context, Option, Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { atom, type Atom } from "./atom"
import { incrementalValidator, invalid } from "./incremental/validate"
import { recordEvent, recordMetadata } from "../runtime/record"
import type { RecordMetadata } from "../services/journal"
import { EventLog, eventLogContext } from "../services/event-log"
import { AtomState, initialStateSeed, type StatefulAtom } from "../initialise"

export interface DurableAtom<State, Event> extends Atom<State>, StatefulAtom {
  readonly name: string
  readonly schema: Schema.Schema<State>
  readonly input: Schema.Schema<Event>
}

/*
const count = durableAtom({
  name: "example.count",
  input: Incremented,       // event schema
  schema: Schema.Finite,    // state schema
  initial: 0,
  reduce: (state, event) => state + event.amount,
})
*/

// durableAtom folds matching input events into validated state and supplies their zero-based journal positions. Schemas must be pure; reducers preserve unchanged references and leave published state unchanged. Plain-data states are frozen (packages/platform/test/properties/runtime/state-validation.ts).
export function durableAtom<State, Event>(options: {
  readonly name: string
  readonly input: Schema.Schema<Event>
  readonly schema: Schema.Schema<State>
  readonly initial: NoInfer<State>
  readonly reduce: (state: NoInfer<State>, event: NoInfer<Event>, metadata: RecordMetadata, position: number) => NoInfer<State>
}): DurableAtom<State, Event> {
  const accepts = Schema.is(options.input)
  if (!options.name.trim()) throw new Error("Durable atom name must not be empty")
  const validate = Schema.decodeUnknownSync(Schema.toType(options.schema), { onExcessProperty: "error" })
  const fast = incrementalValidator(options.schema, () => console.warn(`Durable atom "${options.name}" state is not plain data; validation is O(state)`))
  // check returns the state to keep: the parsed value when the incremental path accepts it, otherwise state after Effect's validation.
  const check = (state: State): State => {
    const parsed = fast.parse(state)
    if (parsed !== invalid) return parsed as State
    validate(state)
    return state
  }
  const decode = (Schema.decodeUnknownSync as unknown as (schema: unknown, options: { readonly onExcessProperty: "error" }) => (value: unknown) => unknown)(options.schema, { onExcessProperty: "error" }) as (value: unknown) => State
  const encode = (Schema.encodeUnknownSync as unknown as (schema: unknown) => (value: unknown) => unknown)(options.schema) as (value: State) => unknown
  const restore = (state: unknown): State => {
    const decoded = decode(state)
    return fast.trust(decoded) as State
  }
  const initial = structuredClone(options.initial)
  validate(initial)
  check(initial)
  const codec = { name: options.name, decode: restore, encode: (value: unknown) => encode(value as State) }
  type Frame = { readonly source: Atom<unknown>; readonly position: number; readonly state: State }
  const reduced = NativeAtom.readable((get): Frame => {
    const context = get(eventLogContext)
    if (!context) throw new Error("Missing EventLog service")
    const service = Context.get(context, EventLog)
    const source = service.replay
    const replay = get(source)
    const { position, seed } = replay
    const previous = Option.getOrUndefined(get.self<Frame>())
    const sameSource = previous !== undefined && previous.source === source
    if (sameSource && previous.position > position) throw new Error("EventLog source must be append-only")
    if (seed && (seed.position < 0 || seed.position > position)) throw new Error(`Atom seed position is outside the event source: ${options.name}`)
    const continued = sameSource && previous.position >= (seed?.position ?? 0)
    const inherited = replay.states?.get(codec)
    const retained = inherited && inherited.position >= (seed?.position ?? 0) ? inherited : undefined
    const fold = (state: State, event: unknown, metadata: RecordMetadata, position: number): State => {
      if (!accepts(event)) return state
      const next = options.reduce(state, event, metadata, position)
      return Object.is(next, state) ? next : check(next)
    }
    let state = continued ? previous.state : retained ? check(retained.value as State) : seed?.state.has(options.name) ? restore(seed.state.get(options.name)) : check(structuredClone(initial))
    let start = continued ? previous.position : retained ? retained.position : seed?.state.has(options.name) ? seed.position : 0
    if (start < position) {
      const records = replay.read(start)
      if (records.length !== position - start) throw new Error(`Durable atom replay range is unavailable: ${options.name}`)
      if (!continued && !retained && start === 0) {
        const initialSeed = initialStateSeed(records)
        if (initialSeed?.state.has(options.name)) state = restore(initialSeed.state.get(options.name))
        start = initialSeed?.position ?? 0
      }
      const from = position - records.length
      let cursor = from
      for (const record of records) {
        if (cursor >= start) state = fold(state, recordEvent(record), recordMetadata(record), cursor)
        cursor++
      }
    }
    return { source, position, state }
  }).pipe(NativeAtom.keepAlive)
  const output = atom(get => get(reduced).state)
  return Object.assign(output, {
    name: options.name,
    schema: options.schema,
    input: options.input,
    [AtomState]: codec,
  })
}
