import type { TreeSession } from "./tree-state"
import type { ReadonlyIndex, ReadonlyLog } from "../runtime/log-view"
import { Context, Schema, type Effect } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { atom, type Atom } from "../atoms/atom"
import type { ObservedRecord, Recorded } from "./journal"
import { EffectDied, type EffectRef } from "../runtime/effects"
import type { StateSeed } from "../initialise"
import type { AcceptedOperation } from "../runtime/operation"
import type { PromiseSettled } from "../runtime/events"
import type { EffectCheckpoint } from "../runtime/replay"

export class EventLog extends Context.Service<EventLog, {
  // events extends an immutable prefix; another history requires another source atom.
  readonly trees?: TreeSession
  readonly events: Atom<ReadonlyLog<unknown>>
  readonly records?: Atom<ReadonlyLog<ObservedRecord<unknown>>>
  // position is the absolute log position immediately before events[0].
  readonly position?: number | (() => number)
  readonly initialState?: StateSeed | (() => StateSeed | undefined)
  readonly bindings?: Atom<ReadonlyIndex<object, EffectRef>>
  readonly effect?: (ref: EffectRef) => AcceptedOperation | undefined
  readonly defect?: () => EffectDied | undefined
  readonly promise?: (ref: EffectRef) => PromiseSettled | undefined
}>()("experimental/EventLog") {}

// ReplayContext supplies committed history during actor setup; runtime/execution.ts caches readFull for the loading attempt.
export class ReplayContext extends Context.Service<ReplayContext, {
  readonly records: readonly Recorded<unknown>[]
  readonly checkpoint?: EffectCheckpoint
  readonly readFull: Effect.Effect<readonly Recorded<unknown>[], Error>
}>()("experimental/ReplayContext") {}

export const eventLogContext = atom<Context.Context<EventLog> | undefined>(undefined).pipe(NativeAtom.withLabel("EventLog"))

// executionDefect observes the terminal journal defect for caller delivery (quint/checkpoint/effectRecovery.qnt, blockedIsDurable).
export const executionDefect = atom(get => {
  const context = get(eventLogContext)
  if (!context) throw new Error("Missing EventLog service")
  const service = Context.get(context, EventLog)
  const events = get(service.events)
  return service.defect ? service.defect() : events.find(Schema.is(EffectDied))
})
