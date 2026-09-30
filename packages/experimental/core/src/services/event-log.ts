import { Context } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { atom, type Atom } from "../atom"
import type { EffectRef } from "../effect-ref"

export class EventLog extends Context.Service<EventLog, {
  // events extends an immutable prefix; another history requires another source atom.
  readonly events: Atom<readonly unknown[]>
  readonly bindings?: Atom<ReadonlyMap<object, EffectRef>>
}>()("experimental/EventLog") {}

export const eventLogContext = atom<Context.Context<EventLog> | undefined>(undefined).pipe(NativeAtom.withLabel("EventLog"))
