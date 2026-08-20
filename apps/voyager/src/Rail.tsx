import { SidebarSimple } from "@phosphor-icons/react"
import { useState, type ReactElement } from "react"

import type { ProblemError } from "@clavia/tardigrade-client"
import { navigate } from "./nav"
import { COLLAPSED_RAIL_WIDTH, ICON_SIZE, PANE_HEADER_HEIGHT, RAIL_WIDTH } from "./policy"
import { agoOf, countsOf, matches, type Roster, type RootRow } from "./roster"

// The rail: the run's roots and nothing else (mock.html, the aside). A root is a run, and the tree
// under it is the run's own business, so the rail lists the six things a reader chooses between
// rather than the twenty-four threads behind them.

// Where the collapsed state is kept. It is the reader's shape of the screen, not the run's, so it
// lives in the browser and never on the wire (src/theme.ts, THEME_KEY).
const RAIL_KEY = "voyager.rail"

const storedCollapsed = (): boolean => {
  if (typeof localStorage === "undefined") return false
  return localStorage.getItem(RAIL_KEY) === "collapsed"
}

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
  selected
}: {
  readonly headerHeight?: number | undefined
  readonly now: number
  readonly problem: ProblemError | undefined
  readonly roster: Roster
  readonly selected: string | undefined
}): ReactElement => {
  // The search is the rail's own state and reads ids alone: a reader who knows the id types it, and
  // nobody's prose is searched (mock.html, "search id…").
  const [query, setQuery] = useState("")
  // Collapsed keeps the toggle and hides the list, and it survives a reload because a reader who
  // closed the rail wants the pane wide on the next visit too.
  const [collapsed, setCollapsed] = useState(storedCollapsed)
  const rows = roster.roots.filter((row) => matches(row.id, query))
  const label = collapsed ? "Expand the run list" : "Collapse the run list"
  return (
    <aside className={`rail${collapsed ? " rail-collapsed" : ""}`} style={{ width: collapsed ? COLLAPSED_RAIL_WIDTH : RAIL_WIDTH }}>
      <div className="pane-chrome" style={{ height: headerHeight }}>
        <div className="rail-head">
          <div className="mono rail-only rail-section-title">runs</div>
          <button
            type="button"
            className="icon-btn"
            aria-label={label}
            aria-expanded={!collapsed}
            title={label}
            onClick={() => {
              const next = !collapsed
              setCollapsed(next)
              if (typeof localStorage !== "undefined") localStorage.setItem(RAIL_KEY, next ? "collapsed" : "open")
            }}
          >
            <SidebarSimple size={ICON_SIZE} weight="light" aria-hidden="true" />
          </button>
        </div>
        <div className="rail-only" style={{ padding: "0 var(--space-3) 10px" }}>
          <input
            className="input rail-search"
            value={query}
            placeholder="search id…"
            aria-label="search id"
            onChange={(changed) => setQuery(changed.target.value)}
          />
        </div>
      </div>
      {problem === undefined ? null : (
        <div className="problem rail-only" style={{ margin: "0 var(--space-3) 10px" }}>
          <div className="problem-title">{problem.title}</div>
          {problem.detail === undefined ? null : <div className="problem-detail">{problem.detail}</div>}
        </div>
      )}
      <div className="rail-only" style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {rows.map((row) => (
          <Row key={row.id} row={row} now={now} selected={row.id === selected} />
        ))}
      </div>
    </aside>
  )
}
