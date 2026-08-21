import type { ActorSummary, ProblemError } from "@clavia/tardigrade-client"
import { Avatar } from "@base-ui-components/react/avatar"
import { ArrowLeft, ArrowRight, BracketsCurly } from "@phosphor-icons/react"
import { useState, type ReactElement } from "react"

import { navigate } from "./nav"
import {
  ACTOR_DIGEST_CHARS,
  ACTOR_MARK_CHARS,
  ACTOR_MARK_SIZE,
  COLLAPSED_ACTOR_RAIL_WIDTH,
  ICON_SIZE,
  PANE_HEADER_HEIGHT,
  RAIL_WIDTH
} from "./policy"
import { ProductMark } from "./ProductMark"
import { actorMarkOf, digestLabelOf, matches } from "./roster"
import { ThemeToggle } from "./ThemeToggle"

const ACTOR_RAIL_KEY = "voyager.actor-rail"

const storedCollapsed = (): boolean => {
  if (typeof localStorage === "undefined") return false
  return localStorage.getItem(ACTOR_RAIL_KEY) === "collapsed"
}

export const ActorRail = ({
  actors,
  collapsedWidth = COLLAPSED_ACTOR_RAIL_WIDTH,
  digestChars = ACTOR_DIGEST_CHARS,
  headerHeight = PANE_HEADER_HEIGHT,
  markChars = ACTOR_MARK_CHARS,
  markSize = ACTOR_MARK_SIZE,
  problem,
  selected,
  width = RAIL_WIDTH
}: {
  readonly actors: ReadonlyArray<ActorSummary>
  readonly collapsedWidth?: number | undefined
  readonly digestChars?: number | undefined
  readonly headerHeight?: number | undefined
  readonly markChars?: number | undefined
  readonly markSize?: number | undefined
  readonly problem: ProblemError | undefined
  readonly selected: string | undefined
  readonly width?: number | undefined
}): ReactElement => {
  const [query, setQuery] = useState("")
  const [collapsed, setCollapsed] = useState(storedCollapsed)
  const shown = actors.filter((actor) => matches(actor.name, query))
  const label = collapsed ? "Expand the actor list" : "Collapse the actor list"
  return (
    <aside
      className={`actor-rail${collapsed ? " actor-rail-collapsed" : ""}`}
      style={{ width: collapsed ? collapsedWidth : width }}
    >
      <div className="pane-chrome" style={{ height: headerHeight }}>
        <div className="actor-head">
          <div className="actor-only actor-identity">
            <ProductMark />
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
      {!collapsed ? null : (
        <div className="actor-mark-list" aria-label="actors">
          {actors.map((actor) => {
            const chosen = actor.name === selected
            return (
              <button
                type="button"
                key={actor.name}
                className={`actor-mark-button${chosen ? " actor-mark-selected" : ""}`}
                aria-label={`Open ${actor.name}`}
                aria-current={chosen ? "true" : undefined}
                title={actor.name}
                onClick={() => navigate({ actor: actor.name, thread: undefined, view: undefined, from: undefined, to: undefined })}
              >
                <Avatar.Root className="mono actor-mark" style={{ width: markSize, height: markSize }} aria-hidden="true">
                  <Avatar.Fallback>{actorMarkOf(actor.name, markChars)}</Avatar.Fallback>
                </Avatar.Root>
              </button>
            )
          })}
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
              onClick={() => navigate({ actor: actor.name, thread: undefined, view: undefined, from: undefined, to: undefined })}
            >
              <span className="mono actor-name">{actor.name}</span>
              {actor.builtIn ? (
                <span className="mono actor-kind">built-in</span>
              ) : actor.digest === undefined ? null : (
                <span className="mono actor-kind" title={actor.digest}>sha {digestLabelOf(actor.digest, digestChars)}</span>
              )}
            </button>
          )
        })}
      </div>
      <div className="actor-footer">
        <button
          type="button"
          className="actor-api"
          onClick={() => navigate({ thread: undefined, view: "api", operation: undefined, from: undefined, to: undefined })}
        >
          <BracketsCurly size={ICON_SIZE} weight="light" aria-hidden="true" />
          <span className="actor-only">API</span>
        </button>
        <ThemeToggle className="actor-api" label={<span className="actor-only">Theme</span>} />
      </div>
    </aside>
  )
}
