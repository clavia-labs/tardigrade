import { useState, type ReactElement } from "react"

import type { ProblemError } from "@clavia/tardigrade-client"
import { navigate } from "./nav"
import { PANE_HEADER_HEIGHT, RAIL_WIDTH } from "./policy"
import { agoOf, countsOf, matches, type Roster, type RootRow } from "./roster"

// The rail: the run's roots and nothing else (mock.html, the aside). A root is a run, and the tree
// under it is the run's own business, so the rail lists the six things a reader chooses between
// rather than the twenty-four threads behind them.

const Row = ({
  now,
  row,
  selected
}: {
  readonly now: number
  readonly row: RootRow
  readonly selected: boolean
}): ReactElement => {
  // Choosing a run clears the window: the edges are fractions of the log a reader was looking at,
  // and they name nothing in the log they are moving to (src/nav.ts, Route).
  const open = () => navigate({ thread: row.id, from: undefined, to: undefined })
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
  headerHeight = PANE_HEADER_HEIGHT,
  now,
  problem,
  roster,
  selected,
  width = RAIL_WIDTH
}: {
  readonly headerHeight?: number | undefined
  readonly now: number
  readonly problem: ProblemError | undefined
  readonly roster: Roster
  readonly selected: string | undefined
  readonly width?: number | undefined
}): ReactElement => {
  // The search is the rail's own state and reads ids alone: a reader who knows the id types it, and
  // nobody's prose is searched (mock.html, "search id…").
  const [query, setQuery] = useState("")
  const rows = roster.roots.filter((row) => matches(row.id, query))
  return (
    <aside className="rail" style={{ width }}>
      <div className="pane-chrome" style={{ height: headerHeight }}>
        <div className="rail-head">
          <div className="mono rail-section-title">runs</div>
        </div>
      </div>
      <div style={{ padding: "10px var(--space-3)" }}>
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
