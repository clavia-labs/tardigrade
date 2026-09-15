import { useState, type ReactElement } from "react"

type Phase = "model" | "tool" | "done" | "exhausted" | "denied"

export const StateExplosionDiagram = (): ReactElement => {
  const [phase, setPhase] = useState<Phase>("model")
  const [allowed, setAllowed] = useState(true)
  const [permitted, setPermitted] = useState(true)
  const restart = () => setPhase("model")
  return (
    <figure className="state-explosion" aria-label="A tool-calling agent with budget and permission rules">
      <div className="state-explosion-options" role="group" aria-label="Tool budget">
        <span className="ship-projection-label">Tool budget</span>
        <button type="button" aria-pressed={allowed} onClick={() => setAllowed(true)}>Allowed</button>
        <button type="button" aria-pressed={!allowed} onClick={() => setAllowed(false)}>Exhausted</button>
      </div>
      <div className="state-explosion-options" role="group" aria-label="Tool permission">
        <span className="ship-projection-label">Tool permission</span>
        <button type="button" aria-pressed={permitted} onClick={() => setPermitted(true)}>Granted</button>
        <button type="button" aria-pressed={!permitted} onClick={() => setPermitted(false)}>Denied</button>
      </div>
      <svg className="budget-agent-machine" viewBox="0 0 900 455" role="img" aria-label={`The agent is ${phase === "model" ? "calling the model" : phase === "tool" ? "running a tool" : phase === "done" ? "done" : phase === "exhausted" ? "stopped because the budget is exhausted" : "stopped because permission was denied"}. Tool calls are ${allowed && permitted ? "allowed" : "blocked"}.`}>
        <g className="budget-agent-links">
          <path d="M15 120H98m-8-5 8 5-8 5" />
          <path data-active={phase === "model" && allowed && permitted} d="M202 80Q320-5 438 80m-10-2 10 2-3-10" />
          <path data-active={phase === "tool"} d="M438 160Q320 245 202 160m3 10-3-10 10 2" />
          <path data-active={phase === "model"} d="M160 183v105m-5-8 5 8 5-8" />
          <path data-active={phase === "model" && !allowed} d="M205 165C270 225 350 300 423 330m-10 1 10-1-6-8" />
          <path data-active={phase === "model" && allowed && !permitted} d="M210 88C440-35 800 25 800 287m-5-8 5 8 5-8" />
        </g>
        <g className="budget-agent-labels">
          <text x="53" y="83"><tspan x="53">message</tspan><tspan x="53" dy="14">received</tspan></text>
          <text x="320" y="29"><tspan x="320">tool called</tspan><tspan x="320" dy="15">[budget allowed, permission granted]</tspan></text>
          <text x="320" y="224">tool returned</text>
          <text x="236" y="270">turn completed</text>
          <text x="380" y="278"><tspan x="380">tool requested</tspan><tspan x="380" dy="15">[budget exhausted]</tspan></text>
          <text x="688" y="68"><tspan x="688">tool requested</tspan><tspan x="688" dy="15">[budget allowed, permission denied]</tspan></text>
        </g>
        {([
          { id: "model", x: 160, y: 120, lines: ["Calling", "model"] },
          { id: "tool", x: 480, y: 120, lines: ["Running", "tool"] },
          { id: "done", x: 160, y: 350, lines: ["Done"] },
          { id: "exhausted", x: 480, y: 350, lines: ["Budget", "exhausted"] },
          { id: "denied", x: 800, y: 350, lines: ["Permission", "denied"] }
        ] as const).map((state) => <g key={state.id} className="agent-state-node" data-current={phase === state.id} transform={`translate(${state.x} ${state.y})`}>
          <circle r="60" />
          {(state.id === "done" || state.id === "exhausted" || state.id === "denied") && <circle r="54" />}
          <text y={state.lines.length === 1 ? 4 : -5}>{state.lines.map((line, index) => <tspan key={line} x="0" dy={index === 0 ? 0 : 19}>{line}</tspan>)}</text>
        </g>)}
      </svg>
      <div className="state-explosion-playback">
        <span className="agent-state-prompt" aria-live="polite">{phase === "model" ? "The model responds with…" : phase === "tool" ? "The tool finishes…" : phase === "done" ? "The turn is complete." : phase === "exhausted" ? "No budget remains for another tool call." : "This tool call needs permission."}</span>
        <div className="agent-state-actions">
          {phase === "model" ? <>
            <button type="button" onClick={() => setPhase(!allowed ? "exhausted" : permitted ? "tool" : "denied")}>Tool call</button>
            <button type="button" onClick={() => setPhase("done")}>Final answer</button>
          </> : phase === "tool" ? <button type="button" onClick={() => setPhase("model")}>Return tool result</button> : null}
          <button type="button" onClick={restart}>{phase === "done" || phase === "exhausted" || phase === "denied" ? "New message" : "Restart"}</button>
        </div>
      </div>
      <figcaption>A tool call needs both budget and permission. A final answer needs neither. Switch the controls to try each path.</figcaption>
    </figure>
  )
}
