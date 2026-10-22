import { createInvocationLookup, type Recorded } from "@clavia/tardigrade-core"
import { selectInvocationRecords } from "../../../core/src/services/journal/invocation"

// memoryInvocationLookup binds fixture records to the core admission projection.
export const memoryInvocationLookup = <Event extends object>(records: () => readonly Recorded<Event>[]) => createInvocationLookup(identity => selectInvocationRecords(records(), identity))
