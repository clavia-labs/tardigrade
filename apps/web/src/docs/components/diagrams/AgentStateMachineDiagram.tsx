import { useState, type ReactElement } from "react"

import { TardigradeAgentIllustration } from "./TardigradeAgentIllustration"

type State = "model" | "tool" | "done"

export const AgentStateMachineDiagram = (): ReactElement => {
  const [state, setState] = useState<State>("model")
  // reachable lists the states one click away from the current one.
  const reachable: ReadonlyArray<State> = state === "model" ? ["tool", "done"] : ["model"]
  const moveTo = (target: State) => { if (reachable.includes(target)) setState(target) }
  const node = (id: State, x: number, y: number, label: string): ReactElement => {
    const open = reachable.includes(id)
    return <g className="agent-state-node" data-current={state === id} data-reachable={open} transform={`translate(${x} ${y})`} role="button" tabIndex={open ? 0 : -1} aria-disabled={!open} aria-label={`${label}${open ? "" : " (not reachable now)"}`} onClick={() => moveTo(id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); moveTo(id) } }}>
      {open && <circle className="agent-state-halo" r="60" />}
      <circle r="52" />
      {id === "done" && <circle r="46" />}
      {id === "done" ? <text y="4">Done</text> : <text y="-4"><tspan x="0">{label.split(" ")[0]}</tspan><tspan x="0" dy="18">{label.split(" ")[1]}</tspan></text>}
    </g>
  }
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
          <path data-active={state === "done"} d="M16 115H117m-8-5 8 5-8 5" />
          <path data-active={state === "model"} d="M211 75Q305 0 399 75m-10-2 10 2-3-10" />
          <path data-active={state === "tool"} d="M399 155Q305 225 211 155m3 10-3-10 10 2" />
          <path data-active={state === "model"} d="M175 173v104m-5-8 5 8 5-8" />
        </g>
        <g className="agent-state-labels">
          <text x="66" y="78"><tspan x="66">message</tspan><tspan x="66" dy="15">received</tspan></text>
          <text x="305" y="22">tool called</text>
          <text x="305" y="216">tool returned</text>
          <text x="250" y="260">turn completed</text>
        </g>
        {node("model", 175, 115, "Calling model")}
        {node("tool", 435, 115, "Running tool")}
        {node("done", 175, 335, "Done")}
      </svg>
        </div>
      </div>
      <figcaption>
        <span className="agent-state-prompt" aria-live="polite">{state === "model" ? "The model responds with a tool call or a final answer. Click the next state." : state === "tool" ? "The tool finishes. Click Calling model to return its result." : "The turn is complete. Click Calling model to send a new message."}</span>
      </figcaption>
    </figure>
  )
}
