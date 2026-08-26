import type { Event } from "../log/event"
import type { Transition } from "./transition"

// Reactor derives transitions as a pure projection of the event set. It ignores event order and
// ambient time (tla/runtime/Projection.tla, ViewFaithful), and it omits work whose prerequisite is
// absent (tla/runtime/Reconcile.tla, QuietIsBlocked).
export type Reactor<R = never> = (events: ReadonlyArray<Event>) => ReadonlyArray<Transition<never, R>>
