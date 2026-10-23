import { durableAtom as makeDurableAtom, type DurableAtom, type DurableAtomOptions } from "../atoms/durable"
import { durableAtomLog } from "./durable-atom-log"
import { durableAtomFamily } from "./durable-atom-family"

export { durableAtomFamily, DEFAULT_DURABLE_ATOM_FAMILY_IDLE_TTL, DEFAULT_DURABLE_ATOM_FAMILY_INDEX_VERSION, DEFAULT_DURABLE_ATOM_FAMILY_PAGE_SIZE, type DurableAtomFamily, type DurableAtomFamilyOptions, type FamilyPageOptions } from "./durable-atom-family"
export { durableAtomLog, LogRef, DEFAULT_DURABLE_ATOM_LOG_PAGE_SIZE, DEFAULT_DURABLE_ATOM_LOG_IDLE_TTL, DEFAULT_DURABLE_ATOM_LOG_INDEX_VERSION, type DurableAtomLog, type DurableAtomLogOptions, type LogPage, type LogCursor, type LogRangeOptions } from "./durable-atom-log"
export type { DurableAtom, DurableAtomOptions }

// durableAtom exposes keyed families and ordered logs alongside ordinary durable atoms on the experimental surface.
export const durableAtom = Object.assign(<State, Event>(options: DurableAtomOptions<State, Event>): DurableAtom<State, Event> => makeDurableAtom(options), { family: durableAtomFamily, log: durableAtomLog })
