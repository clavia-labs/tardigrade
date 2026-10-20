import type { ReadonlyLog } from "../../runtime/log-view"
import { Context, Option, Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { atom, type Atom } from "../atom"
import { EventLog, eventLogContext } from "../../services/event-log"
import { AtomState, type StatefulAtom } from "../../initialise"
import type { RecordMetadata } from "../../services/journal"
import type { DurableAtom } from "./atom"

// durableProjection shares journal folding between value and tree-backed atoms.
export function durableProjection<State, Event, Output = State>(options: {
  readonly name: string
  readonly schema: Schema.Top
  readonly input: Schema.Schema<Event>
  readonly reduce: (state: State, event: Event, metadata: RecordMetadata, position: number) => State
}, codec: {
  readonly initial: (service: typeof EventLog.Service) => State
  readonly restore: (value: unknown, service: typeof EventLog.Service) => State
  readonly check: (value: State, service: typeof EventLog.Service) => State
  readonly hold?: (value: State, service: typeof EventLog.Service) => void
  readonly view?: (state: State) => Output
  readonly capture?: (state: State) => { readonly state: unknown; readonly reference?: string }
  readonly state: StatefulAtom[typeof AtomState]
}): DurableAtom<Output, Event> {
  if (!options.name.trim()) throw new Error("Durable atom name must not be empty")
  const accepts = Schema.is(options.input)
  type Frame = { readonly source: Atom<ReadonlyLog<unknown>>; readonly position: number; readonly state: State }
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
    const shared = service.reduced?.(reduced)
    if (shared && shared.position === offset + events.length) {
      codec.hold?.(shared.state, service)
      return { source, position: shared.position, state: shared.state }
    }
    const continued = sameSource && previous.position >= (seed?.position ?? offset)
    let state = continued ? previous.state : seed?.state.has(options.name) ? codec.restore(seed.state.get(options.name), service) : codec.initial(service)
    const start = (continued ? previous.position : seed?.position ?? offset) - offset
    for (let index = Math.max(0, start); index < events.length; index++) {
      const event = events.at(index)
      if (!accepts(event)) continue
      const record = records?.at(index)
      const metadata: RecordMetadata = record ? { ...(record.recordedAt === undefined ? {} : { recordedAt: record.recordedAt }), ...(record.message ? { message: record.message } : {}) } : {}
      const next = options.reduce(state, event, metadata, offset + index)
      state = Object.is(next, state) ? next : codec.check(next, service)
    }
    codec.hold?.(state, service)
    return { source, position: offset + events.length, state }
  }).pipe(NativeAtom.keepAlive)
  const output = atom(get => codec.view ? codec.view(get(reduced).state) : get(reduced).state as unknown as Output)
  const state = codec.capture ? { ...codec.state, capture: (get: import("../atom").Getter) => codec.capture!(get(reduced).state) } : codec.state
  return Object.assign(output, { name: options.name, schema: options.schema, input: options.input, [AtomState]: state })
}
