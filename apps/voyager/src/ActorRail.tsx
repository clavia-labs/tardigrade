import type { ActorSummary, ProblemError } from "@clavia/tardigrade-client"
import { useState, type ReactElement } from "react"

import { navigate } from "./nav"
import { ACTOR_RAIL_WIDTH, PANE_HEADER_HEIGHT } from "./policy"
import { matches } from "./roster"

export const ActorRail = ({
  actors,
  headerHeight = PANE_HEADER_HEIGHT,
  problem,
  selected
}: {
  readonly actors: ReadonlyArray<ActorSummary>
  readonly headerHeight?: number | undefined
  readonly problem: ProblemError | undefined
  readonly selected: string | undefined
}): ReactElement => {
  const [query, setQuery] = useState("")
  const shown = actors.filter((actor) => matches(actor.name, query))
  return (
    <aside className="actor-rail" style={{ width: ACTOR_RAIL_WIDTH }}>
      <div className="pane-chrome" style={{ height: headerHeight }}>
        <div className="actor-head">
          <div className="rail-wordmark">voyager</div>
          <div className="mono actor-label">actors</div>
        </div>
      </div>
      <div className="actor-search-wrap">
        <input
          className="input actor-search"
          value={query}
          placeholder="search name…"
          aria-label="search actor name"
          onChange={(changed) => setQuery(changed.target.value)}
        />
      </div>
      {problem === undefined ? null : (
        <div className="problem actor-problem">
          <div className="problem-title">{problem.title}</div>
          {problem.detail === undefined ? null : <div className="problem-detail">{problem.detail}</div>}
        </div>
      )}
      <div className="actor-list">
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
