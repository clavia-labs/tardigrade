import { durableAtom as makeDurableAtom, type DurableAtom, type DurableAtomOptions } from "../atoms/durable"
import { durableAtomFamily } from "./durable-atom-family"

export { durableAtomFamily, DEFAULT_DURABLE_ATOM_FAMILY_IDLE_TTL, DEFAULT_DURABLE_ATOM_FAMILY_INDEX_VERSION, DEFAULT_DURABLE_ATOM_FAMILY_PAGE_SIZE, type DurableAtomFamily, type DurableAtomFamilyOptions, type FamilyPageOptions } from "./durable-atom-family"
export type { DurableAtom, DurableAtomOptions }

// durableAtom exposes keyed families alongside ordinary durable atoms on the experimental surface.
export const durableAtom = Object.assign(<State, Event>(options: DurableAtomOptions<State, Event>): DurableAtom<State, Event> => makeDurableAtom(options), { family: durableAtomFamily })
