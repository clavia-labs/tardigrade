import { useState, type ReactElement } from "react"

import type { VoyagerError } from "./api"
import { navigate } from "./nav"
import { RAIL_WIDTH } from "./policy"
import { agoOf, countsOf, matches, totalsOf, type Roster, type RootRow } from "./roster"

// The rail: the run's roots and nothing else (mock.html, the aside). A root is a run, and the tree
// under it is the run's own business, so the rail lists the six things a reader chooses between
// rather than the twenty-four agents behind them.

const Row = ({
  now,
  row,
  selected
}: {
  readonly now: number
  readonly row: RootRow
  readonly selected: boolean
}): ReactElement => {
  const open = () => navigate({ agent: row.id, at: undefined })
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected ? "true" : undefined}
      className={`rail-row${selected ? " rail-row-selected" : ""}`}
      onClick={open}
      onKeyDown={(pressed) => {
        if (pressed.key !== "Enter" && pressed.key !== " ") return
        pressed.preventDefault()
        open()
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <span className="mono rail-id">{row.id}</span>
        <span className="mono rail-meta">{row.lastAt === undefined ? "" : agoOf(row.lastAt, now)}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <span className={`chip chip-${row.status}${row.status === "running" ? " breathe" : ""}`}>{row.status}</span>
        <span className="mono rail-meta">{countsOf(row)}</span>
      </div>
    </div>
  )
}

export const Rail = ({
  now,
  problem,
  roster,
  selected
}: {
  readonly now: number
  readonly problem: VoyagerError | undefined
  readonly roster: Roster
  readonly selected: string | undefined
}): ReactElement => {
  // The search is the rail's own state and reads ids alone: a reader who knows the id types it, and
  // nobody's prose is searched (mock.html, "search id…").
  const [query, setQuery] = useState("")
  const rows = roster.roots.filter((row) => matches(row.id, query))
  return (
    <aside className="rail" style={{ width: RAIL_WIDTH }}>
      <div style={{ padding: "var(--space-4) var(--space-4) var(--space-1)" }}>
        <div style={{ fontWeight: 600, fontSize: 14, letterSpacing: "-0.01em" }}>voyager</div>
      </div>
      <div className="mono rail-totals">{totalsOf(roster)}</div>
      <div style={{ padding: "0 var(--space-3) 10px" }}>
        <input
          className="input rail-search"
          value={query}
          placeholder="search id…"
          aria-label="search id"
          onChange={(changed) => setQuery(changed.target.value)}
        />
      </div>
      {problem === undefined ? null : (
        <div className="problem" style={{ margin: "0 var(--space-3) 10px" }}>
          <div className="problem-title">{problem.title}</div>
          {problem.detail === undefined ? null : <div className="problem-detail">{problem.detail}</div>}
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {rows.map((row) => (
          <Row key={row.id} row={row} now={now} selected={row.id === selected} />
        ))}
      </div>
    </aside>
  )
}
