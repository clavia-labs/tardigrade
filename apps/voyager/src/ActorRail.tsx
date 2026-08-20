import type { ActorSummary, ProblemError } from "@clavia/tardigrade-client"
import type { ReactElement } from "react"

import { navigate } from "./nav"
import { ACTOR_RAIL_WIDTH } from "./policy"

export const ActorRail = ({
  actors,
  problem,
  selected
}: {
  readonly actors: ReadonlyArray<ActorSummary>
  readonly problem: ProblemError | undefined
  readonly selected: string | undefined
}): ReactElement => (
  <aside className="actor-rail" style={{ width: ACTOR_RAIL_WIDTH }}>
    <div className="actor-head">
      <div className="rail-wordmark">voyager</div>
      <div className="mono actor-label">actors</div>
    </div>
    {problem === undefined ? null : (
      <div className="problem actor-problem">
        <div className="problem-title">{problem.title}</div>
        {problem.detail === undefined ? null : <div className="problem-detail">{problem.detail}</div>}
      </div>
    )}
    <div className="actor-list">
      {actors.map((actor) => {
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
