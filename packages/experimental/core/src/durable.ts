import { Context, Option, Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { atom, type Atom } from "./atom"
import { EventLog, eventLogContext } from "./services/event-log"

export interface DurableAtom<State, Event> extends Atom<State> {
  readonly input: Schema.Schema<Event>
}

/*
const count = durableAtom({
  input: Incremented,       // event schema
  schema: Schema.Finite,    // state schema
  initial: 0,
  reduce: (state, event) => state + event.amount,
})
*/

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
  type Frame = { readonly source: Atom<readonly unknown[]>; readonly position: number; readonly state: State }
  const reduced = NativeAtom.readable((get): Frame => {
    const context = get(eventLogContext)
    if (!context) throw new Error("Missing EventLog service")
    const source = Context.get(context, EventLog).events
    const events = get(source)
    const previous = Option.getOrUndefined(get.self<Frame>())
    const sameSource = previous !== undefined && previous.source === source
    if (sameSource && previous.position > events.length) throw new Error("EventLog source must be append-only")
    let state = sameSource ? previous.state : structuredClone(initial)
    const start = sameSource ? previous.position : 0
    for (let index = start; index < events.length; index++) {
      const event = events[index]
      if (!accepts(event)) continue
      const next = options.reduce(state, event)
      if (!Object.is(next, state)) validate(next)
      state = next
    }
    return { source, position: events.length, state }
  }).pipe(NativeAtom.keepAlive)
  return Object.assign(atom(get => get(reduced).state), { input: options.input })
}
