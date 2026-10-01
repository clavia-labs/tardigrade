import { Context } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { atom, type Atom } from "../atoms/atom"
import type { Recorded } from "./journal"
import type { EffectRef, EffectCancelled } from "../runtime/effects"
import type { DurableAtomCheckpoint } from "../atoms/durable"
import type { EffectRequested, EffectSettled, PromiseSettled } from "../runtime/events"

export class EventLog extends Context.Service<EventLog, {
  // events extends an immutable prefix; another history requires another source atom.
  readonly events: Atom<readonly unknown[]>
  readonly records?: Atom<readonly Recorded<unknown>[]>
  // position is the absolute log position immediately before events[0].
  readonly position?: number | (() => number)
  readonly durable?: ReadonlyMap<string, DurableAtomCheckpoint> | (() => ReadonlyMap<string, DurableAtomCheckpoint> | undefined)
  readonly bindings?: Atom<ReadonlyMap<object, EffectRef>>
  readonly effect?: (ref: EffectRef) => { readonly request: EffectRequested; readonly settlement?: EffectSettled; readonly cancellation?: EffectCancelled } | undefined
  readonly promise?: (ref: EffectRef) => PromiseSettled | undefined
}>()("experimental/EventLog") {}

export const eventLogContext = atom<Context.Context<EventLog> | undefined>(undefined).pipe(NativeAtom.withLabel("EventLog"))
