import type { AgentStatus, AgentSummary } from "./api"

// The rail's projections. GET /agents answers with every agent and its parent, and the rail shows
// roots alone, so these functions turn one flat listing into the rows and the totals the rail
// renders. They are pure, so the screen holds no arithmetic of its own.

// RootRow is one rail row: the root's own facts plus the size of the family it started.
export interface RootRow {
  readonly id: string
  readonly status: AgentStatus
  readonly events: number
  readonly lastAt: number | undefined
  // The agents this root spawned, at any depth, not counting the root. Zero for a root that ran
  // alone, and the rail then omits the segment.
  readonly family: number
}

// Roster is the whole rail: the rows and the three numbers above them.
export interface Roster {
  readonly roots: ReadonlyArray<RootRow>
  readonly agents: number
  readonly events: number
}

export const EMPTY_ROSTER: Roster = { roots: [], agents: 0, events: 0 }

// rootOf walks an agent's parents to the root of its family. Parentage is the server's fact: only
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

// rosterOf projects the listing into the rail. The roots keep the order GET /agents published, which
// is first event time, so two polls of one run render identically.
export const rosterOf = (summaries: ReadonlyArray<AgentSummary>): Roster => {
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
      })),
    agents: summaries.length,
    events: summaries.reduce((sum, summary) => sum + summary.events, 0)
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
// its family is. A root that spawned nothing says nothing about agents (mock.html, the rail row).
export const countsOf = (row: RootRow): string =>
  row.family === 0 ? `${row.events} ev` : `${row.events} ev · ${row.family} agents`

// totalsOf is the mono line under the wordmark: the run in three numbers, runs first because a run
// is what a root is (mock.html, "6 runs · 24 agents · 987 events").
export const totalsOf = (roster: Roster): string =>
  `${roster.roots.length} runs · ${roster.agents} agents · ${roster.events} events`
