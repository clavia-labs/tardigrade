import { useState, type ReactElement } from "react"

import { TardigradeAgentIllustration } from "./TardigradeAgentIllustration"

type State = "model" | "tool" | "done"

export const AgentStateMachineDiagram = (): ReactElement => {
  const [state, setState] = useState<State>("model")
  return (
    <figure className="agent-state-machine" aria-label="A simple tool-calling agent state machine">
      <div className="agent-state-layout">
        <div className="agent-state-character">
          <span className="ship-projection-label">Tool-calling agent</span>
          <TardigradeAgentIllustration working={state === "tool"} thinking={state === "model"} done={state === "done"} />
        </div>
        <div className="agent-state-chart">
          <span className="ship-projection-label">State machine</span>
      <svg viewBox="0 0 580 410" role="img" aria-label={`Current state: ${state === "model" ? "Calling model" : state === "tool" ? "Running tool" : "Done"}. A tool call leads to running a tool. Its result leads back to calling the model. A final answer completes the turn.`}>
        <g className="agent-state-links">
          <path d="M16 115H117m-8-5 8 5-8 5" />
          <path d="M211 75Q305 0 399 75m-10-2 10 2-3-10" />
          <path d="M399 155Q305 225 211 155m3 10-3-10 10 2" />
          <path d="M175 173v104m-5-8 5 8 5-8" />
        </g>
        <g className="agent-state-labels">
          <text x="66" y="78"><tspan x="66">message</tspan><tspan x="66" dy="15">received</tspan></text>
          <text x="305" y="22">tool called</text>
          <text x="305" y="216">tool returned</text>
          <text x="250" y="260">turn completed</text>
        </g>
        <g className="agent-state-node" data-current={state === "model"} transform="translate(175 115)">
          <circle r="52" />
          <text y="-4"><tspan x="0">Calling</tspan><tspan x="0" dy="18">model</tspan></text>
        </g>
        <g className="agent-state-node" data-current={state === "tool"} transform="translate(435 115)">
          <circle r="52" />
          <text y="-4"><tspan x="0">Running</tspan><tspan x="0" dy="18">tool</tspan></text>
        </g>
        <g className="agent-state-node" data-current={state === "done"} transform="translate(175 335)">
          <circle r="52" /><circle r="46" />
          <text y="4">Done</text>
        </g>
      </svg>
        </div>
      </div>
      <figcaption>
        <span className="agent-state-prompt" aria-live="polite">{state === "model" ? "The model responds with…" : state === "tool" ? "The tool finishes…" : "The turn is complete."}</span>
        <div className="agent-state-actions">
          {state === "model" ? <>
            <button type="button" onClick={() => setState("tool")}>Tool call</button>
            <button type="button" onClick={() => setState("done")}>Final answer</button>
          </> : state === "tool" ?
            <button type="button" onClick={() => setState("model")}>Return tool result</button> :
            <button type="button" onClick={() => setState("model")}>New message</button>}
        </div>
      </figcaption>
    </figure>
  )
}
