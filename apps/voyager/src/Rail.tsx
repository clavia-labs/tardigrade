import { useState, type ReactElement } from "react"

import type { ActorMetadata, ProblemError } from "@clavia/tardigrade-client"
import { ArrowUpRight, CaretLeft, CaretRight, Plus } from "@phosphor-icons/react"
import { docsUrl } from "./client"
import { navigate } from "./nav"
import { ICON_SIZE, RAIL_COLLAPSED_WIDTH, RAIL_HEADER_HEIGHT, RAIL_WIDTH } from "./policy"
import { ProductMark } from "./ProductMark"
import { agoOf, countsOf, matches, type Roster, type RootRow } from "./roster"
import { ThemeToggle } from "./ThemeToggle"

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
  const open = () => navigate({ thread: row.id, view: undefined, from: undefined, to: undefined })
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

const storageLabel = (location: string): string =>
  location === ":memory:" ? location : location.split(/[\\/]/).slice(-2).join("/")

export const Rail = ({
  actorMetadata,
  collapsedWidth = RAIL_COLLAPSED_WIDTH,
  headerHeight = RAIL_HEADER_HEIGHT,
  now,
  problem,
  roster,
  selected,
  width = RAIL_WIDTH
}: {
  readonly actorMetadata: ActorMetadata | undefined
  readonly collapsedWidth?: number | undefined
  readonly headerHeight?: number | undefined
  readonly now: number
  readonly problem: ProblemError | undefined
  readonly roster: Roster
  readonly selected: string | undefined
  readonly width?: number | undefined
}): ReactElement => {
  // query is the rail's local id filter (roster.test.ts, "matches").
  const [query, setQuery] = useState("")
  const [collapsed, setCollapsed] = useState(false)
  const rows = roster.roots.filter((row) => matches(row.id, query))
  return (
    <aside className="rail" data-collapsed={collapsed} style={{ width: collapsed ? collapsedWidth : width }}>
      <div className="pane-chrome" style={{ height: headerHeight }}>
        <div className="rail-head">
          {collapsed ? null : <div className="rail-identity">
            <ProductMark />
          </div>}
          <button
            type="button"
            className="rail-collapse"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed((held) => !held)}
          >
            {collapsed
              ? <CaretRight size={ICON_SIZE} weight="light" aria-hidden="true" />
              : <CaretLeft size={ICON_SIZE} weight="light" aria-hidden="true" />}
          </button>
        </div>
      </div>
      {collapsed ? null : <><div className="rail-actions">
        <div className="rail-actor">
          <div className="mono rail-actor-name">{actorMetadata?.name ?? "\u00a0"}</div>
          <div className="mono rail-actor-sqlite" title={actorMetadata?.storage.location ?? actorMetadata?.storage.kind}>
            {actorMetadata === undefined
              ? "\u00a0"
              : actorMetadata.storage.location === undefined
              ? actorMetadata.storage.kind
              : storageLabel(actorMetadata.storage.location)}
          </div>
        </div>
        <input
          className="input rail-search"
          value={query}
          placeholder="search thread id"
          aria-label="search thread id"
          onChange={(changed) => setQuery(changed.target.value)}
        />
        <button
          type="button"
          className="rail-new-thread"
          onClick={() => navigate({ thread: undefined, view: "new", from: undefined, to: undefined })}
        >
          <Plus size={ICON_SIZE} weight="light" aria-hidden="true" />
          <span>New thread</span>
        </button>
      </div>
      {problem === undefined ? null : (
        <div className="problem" style={{ margin: "0 var(--space-3) 10px" }}>
          <div className="problem-title">{problem.title}</div>
          {problem.detail === undefined ? null : <div className="problem-detail">{problem.detail}</div>}
        </div>
      )}
      <div className="run-list">
        {rows.map((row) => (
          <Row key={row.id} row={row} now={now} selected={row.id === selected} />
        ))}
      </div>
      <div className="rail-footer">
        <a
          className="rail-utility"
          href={docsUrl()}
          target="_blank"
          rel="noreferrer"
        >
          <ArrowUpRight size={ICON_SIZE} weight="light" aria-hidden="true" />
          <span>API</span>
        </a>
        <ThemeToggle className="rail-utility" label={<span>Theme</span>} />
      </div>
      </>}
    </aside>
  )
}
