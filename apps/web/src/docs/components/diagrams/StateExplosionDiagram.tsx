import { useState, type ReactElement } from "react"

type Phase = "model" | "permission" | "tool" | "done" | "exhausted" | "denied"

const states = [
  { id: "model", x: 160, y: 120, lines: ["Calling", "model"], terminal: false },
  { id: "permission", x: 480, y: 120, lines: ["Requesting", "permission"], terminal: false },
  { id: "tool", x: 800, y: 120, lines: ["Running", "tool"], terminal: false },
  { id: "done", x: 160, y: 350, lines: ["Done"], terminal: true },
  { id: "exhausted", x: 480, y: 350, lines: ["Budget", "exhausted"], terminal: true },
  { id: "denied", x: 800, y: 350, lines: ["Permission", "denied"], terminal: true }
] as const

const prompts: Record<Phase, string> = {
  model: "The model responds. Click the next state.",
  permission: "The tool call asks for permission. Click the outcome.",
  tool: "The tool finishes. Click Calling model to return its result.",
  done: "The turn is complete. Click Calling model to send a new message.",
  exhausted: "No budget remains. Click Calling model to send a new message.",
  denied: "Permission was denied. Click Calling model to send a new message."
}

const descriptions: Record<Phase, string> = {
  model: "calling the model",
  permission: "waiting for permission",
  tool: "running a tool",
  done: "done",
  exhausted: "stopped because the budget is exhausted",
  denied: "stopped because permission was denied"
}

export const StateExplosionDiagram = (): ReactElement => {
  const [phase, setPhase] = useState<Phase>("model")
  // reachable lists the states one click away; the reader decides each check by clicking its outcome.
  const reachable: ReadonlyArray<Phase> = phase === "model"
    ? ["done", "permission", "exhausted"]
    : phase === "permission" ? ["tool", "denied"] : ["model"]
  const moveTo = (target: Phase) => { if (reachable.includes(target)) setPhase(target) }
  return (
    <figure className="state-explosion" aria-label="A tool-calling agent with budget and permission rules">
      <svg className="budget-agent-machine" viewBox="0 -60 900 490" role="img" aria-label={`The agent is ${descriptions[phase]}. Reachable next: ${reachable.map((id) => states.find((state) => state.id === id)!.lines.join(" ")).join(", ")}.`}>
        <g className="budget-agent-links">
          <path data-active={phase === "done" || phase === "exhausted" || phase === "denied"} d="M15 120H98m-8-5 8 5-8 5" />
          <path data-active={phase === "model"} d="M222 120h196m-8-5 8 5-8 5" />
          <path data-active={phase === "permission"} d="M542 120h196m-8-5 8 5-8 5" />
          <path data-active={phase === "tool"} d="M800 58C770-50 190-50 160 58m-6-9 6 9 6-9" />
          <path data-active={phase === "model"} d="M160 182v104m-5-8 5 8 5-8" />
          <path data-active={phase === "model"} d="M205 165C270 225 350 300 423 330m-10 1 10-1-6-8" />
          <path data-active={phase === "permission"} d="M525 165C590 225 670 300 743 330m-10 1 10-1-6-8" />
        </g>
        <g className="budget-agent-labels">
          <text x="53" y="83"><tspan x="53">message</tspan><tspan x="53" dy="14">received</tspan></text>
          <text x="320" y="96"><tspan x="320">tool called</tspan><tspan x="320" dy="15">[budget allowed]</tspan></text>
          <text x="640" y="108">permission granted</text>
          <text x="480" y="-34">tool returned</text>
          <text x="236" y="270">turn completed</text>
          <text x="415" y="255"><tspan x="415">tool called</tspan><tspan x="415" dy="15">[budget exhausted]</tspan></text>
          <text x="735" y="255">permission denied</text>
        </g>
        {states.map((state) => {
          const open = reachable.includes(state.id)
          return <g key={state.id} className="agent-state-node" data-current={phase === state.id} data-reachable={open} transform={`translate(${state.x} ${state.y})`} role="button" tabIndex={open ? 0 : -1} aria-disabled={!open} aria-label={`${state.lines.join(" ")}${open ? "" : " (not reachable now)"}`} onClick={() => moveTo(state.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); moveTo(state.id) } }}>
            {open && <circle className="agent-state-halo" r="68" />}
            <circle r="60" />
            {state.terminal && <circle r="54" />}
            <text y={state.lines.length === 1 ? 4 : -5}>{state.lines.map((line, index) => <tspan key={line} x="0" dy={index === 0 ? 0 : 19}>{line}</tspan>)}</text>
          </g>
        })}
      </svg>
      <div className="state-explosion-playback">
        <span className="agent-state-prompt" aria-live="polite">{prompts[phase]}</span>
      </div>
      <figcaption>A tool call needs budget before it can ask for permission, and permission before the tool runs. A final answer needs neither. Click a highlighted state to move.</figcaption>
    </figure>
  )
}
