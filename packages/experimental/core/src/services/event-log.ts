import { Context } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { atom, type Atom } from "../atom"
import type { EffectRef } from "../effect-ref"
import type { DurableAtomCheckpoint } from "../durable"
import type { EffectRequested, EffectSettled, PromiseSettled } from "../lifecycle"

export class EventLog extends Context.Service<EventLog, {
  // events extends an immutable prefix; another history requires another source atom.
  readonly events: Atom<readonly unknown[]>
  // position is the absolute log position immediately before events[0].
  readonly position?: number | (() => number)
  readonly durable?: ReadonlyMap<string, DurableAtomCheckpoint> | (() => ReadonlyMap<string, DurableAtomCheckpoint> | undefined)
  readonly bindings?: Atom<ReadonlyMap<object, EffectRef>>
  readonly effect?: (ref: EffectRef) => { readonly request: EffectRequested; readonly settlement?: EffectSettled } | undefined
  readonly promise?: (ref: EffectRef) => PromiseSettled | undefined
}>()("experimental/EventLog") {}

export const eventLogContext = atom<Context.Context<EventLog> | undefined>(undefined).pipe(NativeAtom.withLabel("EventLog"))
