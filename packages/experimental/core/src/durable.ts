import { Context, Option, Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { atom, type Atom } from "./atom"

export class EventLog extends Context.Service<EventLog, {
  readonly events: Atom<readonly unknown[]>
}>()("experimental/EventLog") {}

export const eventLogContext = atom<Context.Context<EventLog> | undefined>(undefined).pipe(NativeAtom.withLabel("EventLog"))

export interface DurableAtom<State, Event> extends Atom<State> {
  readonly input: Schema.Schema<Event>
}

// durableAtom folds matching input events into validated state; reducers must preserve unchanged references and leave their input state unchanged.
export function durableAtom<State, Event>(options: {
  readonly input: Schema.Schema<Event>
  readonly schema: Schema.Schema<State>
  readonly initial: NoInfer<State>
  readonly reduce: (state: NoInfer<State>, event: NoInfer<Event>) => NoInfer<State>
}): DurableAtom<State, Event> {
  const accepts = Schema.is(options.input)
  const validate = Schema.decodeUnknownSync(Schema.toType(options.schema), { onExcessProperty: "error" })
  const initial = structuredClone(options.initial)
  validate(initial)
  type Frame = { readonly events: readonly unknown[]; readonly state: State }
  const reduced = NativeAtom.readable((get): Frame => {
    const context = get(eventLogContext)
    if (!context) throw new Error("Missing EventLog service")
    const events = get(Context.get(context, EventLog).events)
    const previous = Option.getOrUndefined(get.self<Frame>())
    const extendsPrevious = previous !== undefined && previous.events.length <= events.length
      && previous.events.every((event, index) => event === events[index])
    let state = extendsPrevious ? previous.state : structuredClone(initial)
    const start = extendsPrevious ? previous.events.length : 0
    for (let index = start; index < events.length; index++) {
      const event = events[index]
      if (!accepts(event)) continue
      const next = options.reduce(state, event)
      if (!Object.is(next, state)) validate(next)
      state = next
    }
    return { events, state }
  }).pipe(NativeAtom.keepAlive)
  return Object.assign(atom(get => get(reduced).state), { input: options.input })
}
