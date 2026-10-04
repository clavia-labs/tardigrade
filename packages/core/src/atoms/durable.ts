import { Context, Option, Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { atom, type Atom, type Getter } from "./atom"
import { incrementalValidator } from "./state-validation"
import type { RecordMetadata } from "../services/journal"
import { EventLog, eventLogContext } from "../services/event-log"
import { AtomState, type StatefulAtom } from "../initialise"

export interface DurableAtom<State, Event> extends Atom<State>, StatefulAtom {
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
  const check = (state: State): State => {
    if (!fast(state)) validate(state)
    return state
  }
  const decode = (Schema.decodeUnknownSync as unknown as (schema: unknown, options: { readonly onExcessProperty: "error" }) => (value: unknown) => unknown)(options.schema, { onExcessProperty: "error" }) as (value: unknown) => State
  const encode = (Schema.encodeUnknownSync as unknown as (schema: unknown) => (value: unknown) => unknown)(options.schema) as (value: State) => unknown
  const restore = (state: unknown): State => check(decode(state))
  const initial = structuredClone(options.initial)
  validate(initial)
  check(initial)
  type Frame = { readonly source: Atom<readonly unknown[]>; readonly position: number; readonly state: State }
  const reduced = NativeAtom.readable((get): Frame => {
    const context = get(eventLogContext)
    if (!context) throw new Error("Missing EventLog service")
    const service = Context.get(context, EventLog)
    const source = service.events
    const configuredPosition = service.position
    const offset = (typeof configuredPosition === "function" ? configuredPosition() : configuredPosition) ?? 0
    const configuredSeed = service.initialState
    const seed = typeof configuredSeed === "function" ? configuredSeed() : configuredSeed
    const events = get(source)
    const records = service.records ? get(service.records) : undefined
    const previous = Option.getOrUndefined(get.self<Frame>())
    const sameSource = previous !== undefined && previous.source === source
    if (sameSource && previous.position > offset + events.length) throw new Error("EventLog source must be append-only")
    if (seed && (seed.position < offset || seed.position > offset + events.length)) throw new Error(`Atom seed position is outside the event source: ${options.name}`)
    const continued = sameSource && previous.position >= (seed?.position ?? offset)
    let state = continued ? previous.state : seed?.state.has(options.name) ? restore(seed.state.get(options.name)) : check(structuredClone(initial))
    const start = (continued ? previous.position : seed?.position ?? offset) - offset
    for (let index = Math.max(0, start); index < events.length; index++) {
      const event = events[index]
      if (!accepts(event)) continue
      const record = records?.[index]
      const metadata: RecordMetadata = record ? { ...(record.recordedAt === undefined ? {} : { recordedAt: record.recordedAt }), ...(record.message ? { message: record.message } : {}) } : {}
      const next = options.reduce(state, event, metadata, offset + index)
      if (!Object.is(next, state)) check(next)
      state = next
    }
    return { source, position: offset + events.length, state }
  }).pipe(NativeAtom.keepAlive)
  const output = atom(get => get(reduced).state)
  return Object.assign(output, {
    input: options.input,
    [AtomState]: { name: options.name, decode: restore, encode: (get: Getter) => encode(get(output)) },
  })
}
