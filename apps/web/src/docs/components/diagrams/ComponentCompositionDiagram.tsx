import { useState, type ReactElement } from "react"

type Phase = "model" | "tool" | "done"
type Permission = "not requested" | "requested" | "granted" | "denied"

// Node renders one state circle; a reachable node is clickable and carries the halo.
const Node = ({ id, x, y, r, halo, current, reachable, label, terminal = false, onSelect }: {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly r: number
  readonly halo: number
  readonly current: boolean
  readonly reachable: boolean
  readonly label: string
  readonly terminal?: boolean
  readonly onSelect: () => void
}): ReactElement => (
  <g className="composition-node" data-active={current} data-reachable={reachable} transform={`translate(${x} ${y})`} role="button" tabIndex={reachable ? 0 : -1} aria-disabled={!reachable} aria-label={`${label}${reachable ? "" : " (not reachable now)"}`} onClick={() => { if (reachable) onSelect() }} onKeyDown={(event) => { if (reachable && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onSelect() } }}>
    {reachable && <circle className="agent-state-halo" r={halo} />}
    <circle r={r} />
    {terminal && <circle r={r - 4} />}
    {id === "not requested" ? <text y="-3"><tspan x="0">Not</tspan><tspan x="0" dy="12">requested</tspan></text> : <text y="4">{label}</text>}
  </g>
)

export const ComponentCompositionDiagram = (): ReactElement => {
  const [phase, setPhase] = useState<Phase>("model")
  const [budget, setBudget] = useState(true)
  const [permission, setPermission] = useState<Permission>("not requested")
  const [event, setEvent] = useState("MessageReceived")
  const canRunTool = budget && permission === "granted"
  const toolResolved = canRunTool || permission === "denied"
  const next = phase === "done" ? "Turn complete" : phase === "model" ? "Call model" : canRunTool ? "Run tool" : `Tool blocked: ${[!budget && "budget exhausted", permission === "denied" && "permission denied", permission === "requested" && "awaiting permission"].filter(Boolean).join(" and ")}`
  const callTool = () => { setPhase("tool"); setPermission("requested"); setEvent("ToolCalled") }
  const finish = () => { setPhase("done"); setEvent("TurnCompleted") }
  const resolveTool = () => { setPhase("model"); setPermission("not requested"); setEvent(permission === "denied" ? "ToolDenied" : "ToolReturned") }
  const newMessage = () => { setPhase("model"); setPermission("not requested"); setEvent("MessageReceived") }
  const toggleBudget = () => { setBudget(!budget); setEvent(budget ? "BudgetExhausted" : "BudgetReset") }
  const decide = (outcome: "granted" | "denied") => { setPermission(outcome); setEvent(outcome === "granted" ? "PermissionGranted" : "PermissionDenied") }
  return (
    <figure className="component-composition" aria-label="An agent composed of inference, budget, and permission state machines">
      <div className="composition-heading"><span className="ship-projection-label">Agent</span><code aria-live="polite">{event}</code></div>
      <div className="composition-machines">
        <section className="composition-machine" aria-label="Inference component">
          <h4>Inference</h4>
          <svg viewBox="0 0 270 280" role="img" aria-label={`Inference state: ${phase}. Click a highlighted state to move.`}>
            <g className="composition-links">
              <path data-active={phase === "model"} d="M87 48Q135 5 183 48m-8-2 8 2-2-8" />
              <path data-active={phase === "tool" && toolResolved} d="M183 92Q135 133 87 92m2 8-2-8 8 2" />
              <path data-active={phase === "model"} d="M57 110v40m-4-7 4 7 4-7" />
            </g>
            <g className="composition-labels"><text x="135" y="17">tool called</text><text x="143" y="123">tool returned</text><text x="132" y="155">turn completed</text></g>
            <Node id="model" x={57} y={70} r={39} halo={46} label="Model" current={phase === "model"} reachable={phase === "done" || (phase === "tool" && toolResolved)} onSelect={phase === "done" ? newMessage : resolveTool} />
            <Node id="tool" x={213} y={70} r={39} halo={46} label="Tool" current={phase === "tool"} reachable={phase === "model"} onSelect={callTool} />
            <Node id="done" x={57} y={183} r={25} halo={32} label="Done" terminal current={phase === "done"} reachable={phase === "model"} onSelect={finish} />
          </svg>
        </section>
        <section className="composition-machine" aria-label="Budget component">
          <h4>Budget</h4>
          <svg viewBox="0 0 270 280" role="img" aria-label={`Budget state: ${budget ? "Available" : "Exhausted"}. Click the other state to switch.`}>
            <g className="composition-links">
              <path data-active={budget} d="M87 73Q135 28 183 73m-8-2 8 2-2-8" />
              <path data-active={!budget} d="M183 127Q135 172 87 127m2 8-2-8 8 2" />
            </g>
            <g className="composition-labels"><text x="135" y="39">budget spent</text><text x="135" y="169">budget reset</text></g>
            <Node id="available" x={57} y={100} r={39} halo={46} label="Available" current={budget} reachable={!budget} onSelect={toggleBudget} />
            <Node id="exhausted" x={213} y={100} r={39} halo={46} label="Exhausted" current={!budget} reachable={budget} onSelect={toggleBudget} />
          </svg>
        </section>
        <section className="composition-machine" aria-label="Permission component">
          <h4>Permission</h4>
          <svg viewBox="0 0 270 280" role="img" aria-label={`Permission state: ${permission}. Each tool call requests permission. Click Granted or Denied to decide; the call's resolution returns it to not requested.`}>
            <g className="composition-links">
              <path data-active={permission === "not requested" && phase === "model"} d="M135 74v20m-4-7 4 7 4-7" />
              <path data-active={permission === "requested"} d="M117 163Q108 193 82 211m2-8-2 8 8-1" />
              <path data-active={permission === "requested"} d="M153 163Q162 193 188 211m-8-1 8 1-2-8" />
              <path data-active={permission === "granted" && budget} d="M22 226C-2 170 3 38 98 38m-7-4 7 4-7 4" />
              <path data-active={permission === "denied"} d="M248 226C272 170 267 38 172 38m7 4-7-4 7-4" />
            </g>
            <g className="composition-labels">
              <text x="186" y="88">tool called</text>
              <text x="75" y="184">granted</text><text x="195" y="184">denied</text>
              <text x="49" y="111"><tspan x="49">tool</tspan><tspan x="49" dy="11">returned</tspan></text>
              <text x="221" y="111"><tspan x="221">denial</tspan><tspan x="221" dy="11">handled</tspan></text>
            </g>
            <Node id="not requested" x={135} y={38} r={36} halo={43} label="Not requested" current={permission === "not requested"} reachable={false} onSelect={() => undefined} />
            <Node id="requested" x={135} y={131} r={36} halo={43} label="Requested" current={permission === "requested"} reachable={false} onSelect={() => undefined} />
            <Node id="granted" x={57} y={243} r={36} halo={43} label="Granted" current={permission === "granted"} reachable={permission === "requested"} onSelect={() => decide("granted")} />
            <Node id="denied" x={213} y={243} r={36} halo={43} label="Denied" current={permission === "denied"} reachable={permission === "requested"} onSelect={() => decide("denied")} />
          </svg>
        </section>
      </div>
      <div className="composition-join" aria-hidden="true"><span /><span /><span /></div>
      <div className="composition-output" aria-live="polite" aria-atomic="true"><span className="ship-projection-label">Combined output</span><strong>{next}</strong></div>
      <figcaption>Each component tracks its own state. The agent combines their outputs to decide what can run next. Click a highlighted state to move.</figcaption>
    </figure>
  )
}
