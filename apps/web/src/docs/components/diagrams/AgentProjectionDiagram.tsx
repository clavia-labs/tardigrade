import { type ReactElement } from "react"

const events = ["MessageReceived", "ToolCalled", "PermissionGranted", "BudgetSpent", "ToolReturned", "TurnCompleted"]

export const AgentProjectionDiagram = (): ReactElement => {
  const states = [
    { name: "Inference", state: "Done", detail: "The turn has completed" },
    { name: "Budget", state: "Exhausted", detail: "The last available budget was spent" },
    { name: "Permission", state: "Not requested", detail: "The tool returned; its approval is cleared" }
  ]
  return (
    <figure className="agent-projection" aria-label="One event log supplies state to three components">
      <div className="agent-projection-scroll">
        <svg viewBox="0 0 760 430" role="img" aria-label={`After all six events: ${states.map(state => `${state.name}: ${state.state}`).join(", ")}`}>
          <g className="agent-composition-titles"><text x="24" y="24">EVENT LOG</text><text x="350" y="24">AGENT STATE</text></g>
          <rect className="agent-projection-boundary" x="350" y="36" width="404" height="386" />
          <path className="agent-projection-entry" d="M350 219v14" />
          <g className="agent-projection-events">
            {events.map((event, index) => <g key={event} transform={`translate(24 ${48 + index * 62})`}><rect width="274" height="46" /><text className="agent-projection-index" x="14" y="28">{String(index + 1).padStart(2, "0")}</text><text x="47" y="28">{event}</text></g>)}
          </g>
          <g className="composition-links"><path d="M299 226h105M404 102v248M404 102h57m-7-4 7 4-7 4M404 226h57m-7-4 7 4-7 4M404 350h57m-7-4 7 4-7 4" /></g>
          {states.map((state, index) => <g key={state.name} className="agent-projection-state" transform={`translate(474 ${48 + index * 124})`}><rect width="262" height="108" /><path className="agent-projection-divider" d="M0 37h262" /><text className="agent-projection-name" x="18" y="26">{state.name}</text><text className="agent-projection-value" x="18" y="70">{state.state}</text><text className="agent-projection-detail" x="18" y="94">{state.detail}</text></g>)}
        </svg>
      </div>
    </figure>
  )
}
