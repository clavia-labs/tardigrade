import { useState, type ReactElement } from "react"

type Phase = "model" | "tool" | "done"

const BinaryMachine = ({ active, left, right, forward, backward }: {
  readonly active: boolean
  readonly left: string
  readonly right: string
  readonly forward: string
  readonly backward: string
}): ReactElement => (
  <svg viewBox="0 0 270 210" role="img" aria-label={`Current state: ${active ? left : right}. ${forward} moves to ${right}; ${backward} moves to ${left}.`}>
    <g className="composition-links"><path d="M87 73Q135 28 183 73m-8-2 8 2-2-8M183 127Q135 172 87 127m2 8-2-8 8 2" /></g>
    <g className="composition-labels"><text x="135" y="39">{forward}</text><text x="135" y="169">{backward}</text></g>
    {[{ label: left, x: 57, selected: active }, { label: right, x: 213, selected: !active }].map((state) => <g key={state.label} className="composition-node" data-active={state.selected} transform={`translate(${state.x} 100)`}><circle r="39" /><text y="4">{state.label}</text></g>)}
  </svg>
)

export const ComponentCompositionDiagram = (): ReactElement => {
  const [phase, setPhase] = useState<Phase>("model")
  const [budget, setBudget] = useState(true)
  const [permission, setPermission] = useState(true)
  const [event, setEvent] = useState("MessageReceived")
  const canRunTool = budget && permission
  const next = phase === "done" ? "Turn complete" : phase === "model" ? "Call model" : canRunTool ? "Run tool" : `Tool blocked: ${[!budget && "budget exhausted", !permission && "permission denied"].filter(Boolean).join(" and ")}`
  return (
    <figure className="component-composition" aria-label="An agent composed of inference, budget, and permission state machines">
      <div className="composition-heading"><span className="ship-projection-label">Agent</span><code aria-live="polite">{event}</code></div>
      <div className="composition-machines">
        <section className="composition-machine" aria-label="Inference component">
          <h4>Inference</h4>
          <svg viewBox="0 0 270 210" role="img" aria-label={`Inference state: ${phase}`}>
            <g className="composition-links"><path d="M87 48Q135 5 183 48m-8-2 8 2-2-8M183 92Q135 133 87 92m2 8-2-8 8 2M57 110v40m-4-7 4 7 4-7" /></g>
            <g className="composition-labels"><text x="135" y="17">tool called</text><text x="143" y="123">tool returned</text><text x="132" y="155">turn completed</text></g>
            {([{ id: "model", x: 57, y: 70, label: "Model" }, { id: "tool", x: 213, y: 70, label: "Tool" }, { id: "done", x: 57, y: 183, label: "Done" }] as const).map((state) => <g key={state.id} className="composition-node" data-active={phase === state.id} transform={`translate(${state.x} ${state.y})`}><circle r={state.id === "done" ? 25 : 39} />{state.id === "done" && <circle r="21" />}<text y="4">{state.label}</text></g>)}
          </svg>
          <div className="composition-actions">
            {phase === "model" ? <><button type="button" onClick={() => { setPhase("tool"); setEvent("ToolCalled") }}>Tool call</button><button type="button" onClick={() => { setPhase("done"); setEvent("TurnCompleted") }}>Final answer</button></> : phase === "tool" ? <button type="button" disabled={!canRunTool} onClick={() => { setPhase("model"); setEvent("ToolReturned") }}>Tool returned</button> : <button type="button" onClick={() => { setPhase("model"); setEvent("MessageReceived") }}>New message</button>}
          </div>
        </section>
        <section className="composition-machine" aria-label="Budget component">
          <h4>Budget</h4>
          <BinaryMachine active={budget} left="Available" right="Exhausted" forward="budget spent" backward="budget reset" />
          <div className="composition-actions"><button type="button" onClick={() => { setBudget(!budget); setEvent(budget ? "BudgetExhausted" : "BudgetReset") }}>{budget ? "Exhaust budget" : "Reset budget"}</button></div>
        </section>
        <section className="composition-machine" aria-label="Permission component">
          <h4>Permission</h4>
          <BinaryMachine active={permission} left="Granted" right="Denied" forward="permission revoked" backward="permission granted" />
          <div className="composition-actions"><button type="button" onClick={() => { setPermission(!permission); setEvent(permission ? "PermissionRevoked" : "PermissionGranted") }}>{permission ? "Revoke permission" : "Grant permission"}</button></div>
        </section>
      </div>
      <div className="composition-join" aria-hidden="true"><span /><span /><span /></div>
      <div className="composition-output" aria-live="polite" aria-atomic="true"><span className="ship-projection-label">Combined output</span><strong>{next}</strong></div>
      <figcaption>Each component tracks its own state. The agent combines their outputs to decide what can run next.</figcaption>
    </figure>
  )
}
