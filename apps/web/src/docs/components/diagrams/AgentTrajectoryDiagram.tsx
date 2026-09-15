import { useState, type ReactElement } from "react"

const events = [
  { type: "MessageReceived", detail: '"Read notes.txt"', field: 'role: "user"' },
  { type: "ToolCalled", detail: 'name: "read_file"', field: 'callId: "c1"' },
  { type: "ToolReturned", detail: 'result: "Meet at 3"', field: 'callId: "c1"' },
  { type: "TurnCompleted", detail: '"Your meeting is at 3."', field: 'status: "completed"' }
] as const

const projections = {
  turnState: { label: "Turn", description: "Track whether the turn is open" },
  pendingTools: { label: "Tools", description: "Keep calls awaiting a result" },
  enabledEffects: { label: "Effects", description: "Derive the work enabled by state" }
} as const

type Projection = keyof typeof projections

export const AgentTrajectoryDiagram = (): ReactElement => {
  const [selected, setSelected] = useState<Projection>("turnState")
  const [through, setThrough] = useState(events.length - 1)
  const state = events.slice(0, through + 1).reduce((state, event) => {
    switch (event.type) {
      case "MessageReceived": return { ...state, turn: "open", next: "model.generate" }
      case "ToolCalled": return { ...state, pending: ["c1"], next: "service.call" }
      case "ToolReturned": return { ...state, pending: [], next: "model.generate" }
      case "TurnCompleted": return { ...state, turn: "completed", next: "None" }
    }
  }, { turn: "open", pending: [] as string[], next: "None" })
  const result = selected === "turnState"
    ? `{\n  status: "${state.turn}"\n}`
    : selected === "pendingTools"
      ? JSON.stringify(state.pending, null, 2)
      : state.next === "None" ? "[]" : `[\n  "${state.next}"\n]`
  return (
    <figure className="projection-flow" aria-label="Project agent events into turn state, pending tools, or enabled effects.">
      <div className="projection-flow-stage">
        <span className="ship-projection-label">Event log</span>
        <ol className="projection-flow-events">
          {events.map((event, index) => (
            <li key={event.type} className="projection-flow-selectable" data-future={index > through}>
              <button type="button" aria-pressed={through === index} aria-label={`Project through event ${index + 1}: ${event.type}`} onClick={() => setThrough(index)}>
                <strong>{event.type}</strong>
                <code>{event.detail}</code>
                <code>{event.field}</code>
              </button>
            </li>
          ))}
        </ol>
        <span className="projection-flow-note">Select an event to replay</span>
      </div>
      <span className="projection-flow-arrow" aria-hidden="true">→</span>
      <div className="projection-flow-stage">
        <span className="ship-projection-label">Projection function</span>
        <div className="projection-flow-options" role="group" aria-label="Choose an agent projection">
          {(Object.keys(projections) as Projection[]).map((key) => <button key={key} type="button" aria-pressed={selected === key} onClick={() => setSelected(key)}>{projections[key].label}</button>)}
        </div>
        <code className="projection-flow-function">{selected}(log)</code>
        <span className="projection-flow-note">{projections[selected].description}</span>
      </div>
      <span className="projection-flow-arrow" aria-hidden="true">→</span>
      <div className="projection-flow-stage">
        <span className="ship-projection-label">{through === events.length - 1 ? "Final state" : "Projected state"}</span>
        <code className="projection-flow-result" aria-live="polite" aria-atomic="true">{result}</code>
      </div>
    </figure>
  )
}
