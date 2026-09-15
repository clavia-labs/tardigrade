import { type ReactElement } from "react"

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

export const ProjectionFlowDiagram = (): ReactElement => (
  <figure className="ship-projections" aria-label="One event log projected into location, distance, and elapsed time">
    <div className="agent-projection-scroll">
      <svg viewBox="0 0 760 450" role="img" aria-label="Ship state: North Bay at x 9, y 12; distance 21.2 kilometers; elapsed time 55 minutes">
        <g className="ship-projections-titles"><text x="24" y="24">EVENT LOG</text><text x="350" y="24">SHIP STATE</text></g>
        <rect className="agent-projection-boundary" x="350" y="36" width="404" height="396" />
        <path className="agent-projection-entry" d="M350 227v14" />
        <g className="ship-projections-events">
          {events.map((event, index) => <g key={event.spot} transform={`translate(24 ${48 + index * 96})`}>
            <rect width="274" height="84" />
            <text className="ship-projections-event-name" x="14" y="23">PositionUpdated</text>
            <text x="14" y="45">{`spot: "${event.spot}"`}</text>
            <text x="14" y="66">{`x: ${event.x}, y: ${event.y}`}</text>
            <text x="209" y="66">{event.time}</text>
          </g>)}
        </g>
        <g className="composition-links"><path d="M310 234h94M404 105v248M404 105h57m-7-4 7 4-7 4M404 234h57m-7-4 7 4-7 4M404 353h57m-7-4 7 4-7 4" /></g>
        {Object.entries(projections).map(([key, projection], index) => <g key={key} className="agent-projection-state" transform={`translate(474 ${48 + index * 124})`}>
          <rect width="262" height="112" />
          <path className="agent-projection-divider" d="M0 37h262" />
          <text className="agent-projection-name" x="18" y="26">{projection.label}</text>
          <text className="agent-projection-value" x="18" y="71">{key === "currentLocation" ? events.at(-1)!.spot : projection.read()}</text>
          <text className="agent-projection-detail" x="18" y="97">{key === "currentLocation" ? "Latest position: x: 9, y: 12" : projection.description}</text>
        </g>)}
      </svg>
    </div>
  </figure>
)
