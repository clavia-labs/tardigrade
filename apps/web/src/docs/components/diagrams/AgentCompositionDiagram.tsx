import { useState, type ReactElement } from "react"

type ParentState = "model" | "tool" | "done"

// steps is the story in order; next names the parent state the reader clicks to advance.
const steps = [
  { parent: "model", agent: "Idle", next: "tool", output: "The parent calls its model. Click Tool to call the agent tool." },
  { parent: "tool", agent: "Running", next: "model", output: "The parent waits while the agent machine runs. Click Model to return the agent's result." },
  { parent: "model", agent: "Done", next: "done", output: "The agent's answer returns as the tool result. Click Done to complete the parent turn." },
  { parent: "done", agent: "Done", next: "model", output: "The parent produces its final answer. Click Model to send a new message." }
] as const

const Machine = ({ phase, next, onSelect, x, y }: { readonly phase: ParentState; readonly next: ParentState; readonly onSelect: (state: ParentState) => void; readonly x: number; readonly y: number }): ReactElement => (
  <g transform={`translate(${x} ${y})`}>
    <g className="composition-links">
      <path data-active={phase === "model" && next === "tool"} d="M67 40Q125-5 183 40m-8-2 8 2-2-8" />
      <path data-active={phase === "tool"} d="M183 86Q125 128 67 86m2 8-2-8 8 2" />
      <path data-active={phase === "model" && next === "done"} d="M40 100v63m-4-7 4 7 4-7" />
    </g>
    <g className="composition-labels"><text x="125" y="12">tool called</text><text x="125" y="121">tool returned</text><text x="98" y="151">turn completed</text></g>
    {([{ id: "model", label: "Model", x: 40, y: 63 }, { id: "tool", label: "Tool", x: 210, y: 63 }, { id: "done", label: "Done", x: 40, y: 197 }] as const).map(state => {
      const open = next === state.id
      return <g key={state.id} className="composition-node" data-active={phase === state.id} data-reachable={open} transform={`translate(${state.x} ${state.y})`} role="button" tabIndex={open ? 0 : -1} aria-disabled={!open} aria-label={`${state.label}${open ? "" : " (not reachable now)"}`} onClick={() => { if (open) onSelect(state.id) }} onKeyDown={(event) => { if (open && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onSelect(state.id) } }}>
        {open && <circle className="agent-state-halo" r="42" />}
        <circle r="35" />
        {state.id === "done" && <circle r="30" />}
        <text y="4">{state.label}</text>
      </g>
    })}
  </g>
)

export const AgentCompositionDiagram = (): ReactElement => {
  const [step, setStep] = useState(0)
  const current = steps[step] ?? steps[0]
  return (
    <figure className="agent-composition" aria-label="An agent calling another agent through a tool">
      <div className="agent-composition-scroll">
        <svg viewBox="0 0 700 350" role="img" aria-label={current.output}>
          <g className="agent-composition-boundaries"><rect x="16" y="36" width="292" height="296" /></g>
          <g className="agent-composition-titles"><text x="32" y="22">PARENT AGENT</text></g>
          <Machine phase={current.parent} next={current.next} onSelect={() => setStep((step + 1) % steps.length)} x={37} y={84} />
          <g className="composition-node agent-composition-opaque" data-active={current.agent === "Running"} transform="translate(560 160)">
            <circle r="70" />
            <text y="-4"><tspan x="0">Agent</tspan><tspan x="0" dy="19">machine</tspan></text>
            <text className="agent-composition-phase" y="42">{current.agent}</text>
          </g>
          <g className="composition-links">
            <path data-active={current.parent === "model" && current.next === "tool"} d="M283 138Q388 65 492 140m-8-2 8 2-2-8" />
            <path data-active={current.parent === "tool"} d="M492 181Q388 260 283 169m2 8-2-8 8 2" />
          </g>
          <g className="composition-labels"><text x="387" y="87">tool input</text><text x="387" y="240">agent result</text></g>
        </svg>
      </div>
      <div className="agent-composition-status" aria-live="polite">{current.output}</div>
    </figure>
  )
}
