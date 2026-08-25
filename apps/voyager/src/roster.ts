import type { ThreadStatus, ThreadSummary } from "@clavia/tardigrade-client"

// The rail's projections. GET /v1/threads answers with every thread and its parent, and the rail shows
// roots alone, so these functions turn one flat listing into the rows the rail renders. They are
// pure, so the screen holds no arithmetic of its own.

// RootRow is one rail row: the root's own facts plus the size of the family it started.
export interface RootRow {
  readonly id: string
  readonly status: ThreadStatus
  readonly events: number
  readonly lastAt: number | undefined
  // The threads this root spawned, at any depth, not counting the root. Zero for a root that ran
  // alone, and the rail then omits the segment.
  readonly family: number
}

// Roster is the whole rail: the rows, and nothing above them. The rail states a run's counts on the
// run's own row and states no total, because a sum of unrelated runs answers no question a reader
// has (mock.html, the aside).
export interface Roster {
  readonly roots: ReadonlyArray<RootRow>
}

export const EMPTY_ROSTER: Roster = { roots: [] }

export const latestRootOf = (roster: Roster): RootRow | undefined => roster.roots.at(-1)

// rootOf walks a thread's parents to the root of its family. Parentage is the server's fact: only
// the forest can see it, and a summary states it (apps/server/src/projections.ts, treeOf). The
// guard stops a claim cycle, which minted call ids cannot produce but an argument can.
const rootOf = (id: string, parents: ReadonlyMap<string, string | undefined>): string => {
  const walked = new Set<string>([id])
  let here = id
  for (;;) {
    const parent = parents.get(here)
    if (parent === undefined || walked.has(parent)) return here
    walked.add(parent)
    here = parent
  }
}

// rosterOf projects the listing into the rail. The roots keep the order GET /v1/threads published, which
// is first event time, so two polls of one run render identically.
export const rosterOf = (summaries: ReadonlyArray<ThreadSummary>): Roster => {
  const parents = new Map(summaries.map((summary) => [summary.id, summary.parent]))
  const family = new Map<string, number>()
  for (const summary of summaries) {
    if (summary.parent === undefined) continue
    const root = rootOf(summary.id, parents)
    family.set(root, (family.get(root) ?? 0) + 1)
  }
  return {
    roots: summaries
      .filter((summary) => summary.parent === undefined)
      .map((summary) => ({
        id: summary.id,
        status: summary.status,
        events: summary.events,
        lastAt: summary.lastAt,
        family: family.get(summary.id) ?? 0
      }))
  }
}

// matches is the search: an id contains the query, case-folded. The search reads ids alone, so a
// reader who knows what they are looking for finds it and nobody else's prose is scanned.
export const matches = (id: string, query: string): boolean =>
  id.toLowerCase().includes(query.trim().toLowerCase())

// agoOf renders an age in one unit: seconds under a minute, minutes under an hour, hours beyond. A
// timestamp ahead of the reader's clock reads as 0s rather than a negative age, because the
// server's clock and the browser's are two clocks.
export const agoOf = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

// countsOf is a rail row's second line, after the chip: how many events the root holds and how big
// its family is. A root that spawned nothing says nothing about threads (mock.html, the rail row).
export const countsOf = (row: RootRow): string =>
  row.family === 0 ? `${row.events} ev` : `${row.events} ev · ${row.family} threads`
