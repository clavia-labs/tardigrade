import { durableAtom as makeDurableAtom, type DurableAtom, type DurableAtomOptions } from "../atoms/durable"
import { durableAtomLog, type DurableAtomLog, type DurableAtomLogOptions } from "./durable-atom-log"
import { atomLogView, type AtomLogView } from "./log-atom"
import type { LogView } from "./log"
import { durableAtomFamily } from "./durable-atom-family"

export { durableAtomFamily, DEFAULT_DURABLE_ATOM_FAMILY_IDLE_TTL, DEFAULT_DURABLE_ATOM_FAMILY_INDEX_VERSION, DEFAULT_DURABLE_ATOM_FAMILY_PAGE_SIZE, type DurableAtomFamily, type DurableAtomFamilyOptions, type FamilyPageOptions } from "./durable-atom-family"
export { durableAtomLog, DEFAULT_DURABLE_ATOM_LOG_PAGE_SIZE, DEFAULT_DURABLE_ATOM_LOG_IDLE_TTL, DEFAULT_DURABLE_ATOM_LOG_INDEX_VERSION, type DurableAtomLog, type DurableAtomLogOptions, type LogPage, type LogCursor, type LogRangeOptions } from "./durable-atom-log"
export type { DurableAtom, DurableAtomOptions }
export { Log, createLog, LogSelection, LogReadCursor, LogReader, DEFAULT_LOG_PAGE_SIZE, DEFAULT_LOG_READ_BATCH_SIZE, type TypedLog, type LogView, type LogSource, type LogReadOptions, type LogReadPage } from "./log"
export { DEFAULT_LOG_ATOM_IDLE_TTL, type AtomLogView, type AtomLogRangeOptions } from "./log-atom"

function log<Row>(view: LogView<Row>, options?: { readonly idleTTL?: number }): AtomLogView<Row>
function log<Row, Event>(options: DurableAtomLogOptions<Row, Event>): DurableAtomLog<Row, Event>
function log<Row, Event>(view: LogView<Row> | DurableAtomLogOptions<Row, Event>, options?: { readonly idleTTL?: number }): AtomLogView<Row> | DurableAtomLog<Row, Event> {
  return "Range" in view ? atomLogView(view, options) : durableAtomLog(view)
}

// durableAtom exposes keyed families and ordered logs alongside ordinary durable atoms on the experimental surface.
export const durableAtom = Object.assign(<State, Event>(options: DurableAtomOptions<State, Event>): DurableAtom<State, Event> => makeDurableAtom(options), { family: durableAtomFamily, log })
