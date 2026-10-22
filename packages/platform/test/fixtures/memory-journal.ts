import { createInvocationLookup, RuntimeError, type Journal, type Recorded } from "@clavia/tardigrade-core"
import { selectInvocationRecords } from "../../../core/src/services/journal/invocation"

// memoryJournalReads supplies snapshot reads with SQL-compatible prefix and suffix boundaries (properties/runtime/reference-acceptance-atomicity.ts).
export function memoryJournalReads<Event extends object>(records: () => readonly Recorded<Event>[]): Pick<Journal<Event>, "lookupInvocation" | "read" | "readAfter" | "readBefore" | "readInputs"> {
  const slice = (position: number, before: boolean) => {
    const history = records()
    if (!Number.isSafeInteger(position) || position < 0) throw new RuntimeError("Invalid journal position")
    if (position > history.length) throw new RuntimeError(before ? "Checkpoint prefix is unavailable" : "Checkpoint position exceeds journal length")
    return before ? history.slice(0, position) : history.slice(position)
  }
  return {
    lookupInvocation: createInvocationLookup(identity => selectInvocationRecords(records(), identity)),
    read: () => [...records()],
    readAfter: position => slice(position, false),
    readBefore: position => slice(position, true),
    readInputs: () => [],
  }
}
