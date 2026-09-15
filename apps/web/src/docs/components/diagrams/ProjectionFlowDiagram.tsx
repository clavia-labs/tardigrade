import { useState, type ReactElement } from "react"

const events = [
  { spot: "Harbor", x: 4, y: 3, minutes: 0, time: "08:00Z" },
  { spot: "Palm Cove", x: 10, y: 6, minutes: 15, time: "08:15Z" },
  { spot: "Gull Island", x: 16, y: 10, minutes: 35, time: "08:35Z" },
  { spot: "North Bay", x: 9, y: 12, minutes: 55, time: "08:55Z" }
] as const

const projections = {
  currentLocation: { label: "Location", description: "Keep the latest position", read: () => {
    const latest = events.at(-1)!
    return `{\n  spot: "${latest.spot}",\n  x: ${latest.x},\n  y: ${latest.y}\n}`
  } },
  totalDistance: { label: "Distance", description: "Sum the straight segments", read: () => {
    const distance = events.reduce((sum, event, index) => {
      const previous = events[index - 1]
      return previous === undefined ? sum : sum + Math.hypot(event.x - previous.x, event.y - previous.y)
    }, 0)
    return `${distance.toFixed(1)} km`
  } },
  elapsedTime: { label: "Time", description: "Subtract the first timestamp", read: () => `${events.at(-1)!.minutes - events[0].minutes} min` }
} as const

type Projection = keyof typeof projections

export const ProjectionFlowDiagram = (): ReactElement => {
  const [selected, setSelected] = useState<Projection>("currentLocation")
  const projection = projections[selected]
  return (
    <figure className="projection-flow" aria-label="Project the same position events into location, distance, or elapsed time.">
      <div className="projection-flow-stage">
        <span className="ship-projection-label">Event log</span>
        <ol className="projection-flow-events">
          {events.map((event) => (
            <li key={event.spot}>
              <strong>PositionUpdated</strong>
              <code>{`spot: "${event.spot}"`}</code>
              <code>{`x: ${event.x}, y: ${event.y}`}</code>
              <span>{event.time}</span>
            </li>
          ))}
        </ol>
      </div>
      <span className="projection-flow-arrow" aria-hidden="true">→</span>
      <div className="projection-flow-stage">
        <span className="ship-projection-label">Projection function</span>
        <div className="projection-flow-options" role="group" aria-label="Choose a projection">
          {(Object.keys(projections) as Projection[]).map((key) => <button key={key} type="button" aria-pressed={selected === key} onClick={() => setSelected(key)}>{projections[key].label}</button>)}
        </div>
        <code className="projection-flow-function">{selected}(log)</code>
        <span className="projection-flow-note">{projection.description}</span>
      </div>
      <span className="projection-flow-arrow" aria-hidden="true">→</span>
      <div className="projection-flow-stage">
        <span className="ship-projection-label">Final state</span>
        <code className="projection-flow-result" aria-live="polite" aria-atomic="true">{projection.read()}</code>
      </div>
    </figure>
  )
}
