import type { ActorSummary, ProblemError } from "@clavia/tardigrade-client"
import { ArrowLeft, ArrowRight } from "@phosphor-icons/react"
import { useState, type ReactElement } from "react"

import { navigate } from "./nav"
import { ACTOR_RAIL_WIDTH, COLLAPSED_ACTOR_RAIL_WIDTH, ICON_SIZE, PANE_HEADER_HEIGHT } from "./policy"
import { matches } from "./roster"

const ACTOR_RAIL_KEY = "voyager.actor-rail"

const storedCollapsed = (): boolean => {
  if (typeof localStorage === "undefined") return false
  return localStorage.getItem(ACTOR_RAIL_KEY) === "collapsed"
}

export const ActorRail = ({
  actors,
  collapsedWidth = COLLAPSED_ACTOR_RAIL_WIDTH,
  headerHeight = PANE_HEADER_HEIGHT,
  problem,
  selected
}: {
  readonly actors: ReadonlyArray<ActorSummary>
  readonly collapsedWidth?: number | undefined
  readonly headerHeight?: number | undefined
  readonly problem: ProblemError | undefined
  readonly selected: string | undefined
}): ReactElement => {
  const [query, setQuery] = useState("")
  const [collapsed, setCollapsed] = useState(storedCollapsed)
  const shown = actors.filter((actor) => matches(actor.name, query))
  const label = collapsed ? "Expand the actor list" : "Collapse the actor list"
  return (
    <aside
      className={`actor-rail${collapsed ? " actor-rail-collapsed" : ""}`}
      style={{ width: collapsed ? collapsedWidth : ACTOR_RAIL_WIDTH }}
    >
      <div className="pane-chrome" style={{ height: headerHeight }}>
        <div className="actor-head">
          <div className="actor-only actor-identity">
            <div className="rail-wordmark">voyager</div>
            <div className="mono actor-label">actors</div>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label={label}
            aria-expanded={!collapsed}
            title={label}
            onClick={() => {
              const next = !collapsed
              setCollapsed(next)
              if (typeof localStorage !== "undefined") localStorage.setItem(ACTOR_RAIL_KEY, next ? "collapsed" : "open")
            }}
          >
            {collapsed
              ? <ArrowRight size={ICON_SIZE} weight="light" aria-hidden="true" />
              : <ArrowLeft size={ICON_SIZE} weight="light" aria-hidden="true" />}
          </button>
        </div>
      </div>
      <div className="actor-only actor-search-wrap">
        <input
          className="input actor-search"
          value={query}
          placeholder="search name…"
          aria-label="search actor name"
          onChange={(changed) => setQuery(changed.target.value)}
        />
      </div>
      {problem === undefined ? null : (
        <div className="problem actor-only actor-problem">
          <div className="problem-title">{problem.title}</div>
          {problem.detail === undefined ? null : <div className="problem-detail">{problem.detail}</div>}
        </div>
      )}
      <div className="actor-only actor-list">
        {shown.map((actor) => {
          const chosen = actor.name === selected
          return (
            <button
              type="button"
              key={actor.name}
              className={`actor-row${chosen ? " actor-row-selected" : ""}`}
              aria-current={chosen ? "true" : undefined}
              onClick={() => navigate({ actor: actor.name, thread: undefined, from: undefined, to: undefined })}
            >
              <span className="mono actor-name">{actor.name}</span>
              {actor.builtIn ? <span className="mono actor-kind">built-in</span> : null}
            </button>
          )
        })}
      </div>
    </aside>
  )
}
