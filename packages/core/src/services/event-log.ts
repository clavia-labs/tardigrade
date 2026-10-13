import type { ReadonlyIndex, ReadonlyLog } from "../runtime/log-view"
import { Context, Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { atom, type Atom } from "../atoms/atom"
import type { ObservedRecord } from "./journal"
import { EffectDied, type EffectRef, type EffectCancelled } from "../runtime/effects"
import type { StateSeed } from "../initialise"
import type { EffectAcceptance, EffectSettled, PromiseSettled } from "../runtime/events"

export class EventLog extends Context.Service<EventLog, {
  // events extends an immutable prefix; another history requires another source atom.
  readonly events: Atom<ReadonlyLog<unknown>>
  readonly records?: Atom<ReadonlyLog<ObservedRecord<unknown>>>
  // position is the absolute log position immediately before events[0].
  readonly position?: number | (() => number)
  readonly initialState?: StateSeed | (() => StateSeed | undefined)
  readonly bindings?: Atom<ReadonlyIndex<object, EffectRef>>
  readonly effect?: (ref: EffectRef) => { readonly request: EffectAcceptance; readonly settlement?: EffectSettled; readonly cancellation?: EffectCancelled } | undefined
  readonly defect?: () => EffectDied | undefined
  readonly promise?: (ref: EffectRef) => PromiseSettled | undefined
}>()("experimental/EventLog") {}

export const eventLogContext = atom<Context.Context<EventLog> | undefined>(undefined).pipe(NativeAtom.withLabel("EventLog"))

// executionDefect observes the terminal journal defect for caller delivery (quint/checkpoint/effectRecovery.qnt, blockedIsDurable).
export const executionDefect = atom(get => {
  const context = get(eventLogContext)
  if (!context) throw new Error("Missing EventLog service")
  const service = Context.get(context, EventLog)
  const events = get(service.events)
  return service.defect ? service.defect() : events.find(Schema.is(EffectDied))
})
