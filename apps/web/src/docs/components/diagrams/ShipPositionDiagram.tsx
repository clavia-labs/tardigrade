import { useState, type CSSProperties, type ReactElement, type ReactNode } from "react"

const moves = [
  { type: "PositionUpdated", spot: "Harbor", x: 4, y: 3, at: Date.UTC(2026, 8, 8, 8, 0) },
  { type: "PositionUpdated", spot: "Palm Cove", x: 10, y: 6, at: Date.UTC(2026, 8, 8, 8, 15) },
  { type: "PositionUpdated", spot: "Gull Island", x: 16, y: 10, at: Date.UTC(2026, 8, 8, 8, 35) },
  { type: "PositionUpdated", spot: "North Bay", x: 9, y: 12, at: Date.UTC(2026, 8, 8, 8, 55) }
] as const

const mapPoint = ({ x, y }: { readonly x: number; readonly y: number }): readonly [number, number] =>
  [44 + 20 * x, 323 - 20 * y]

const legs = [
  "M124 263C170 273 183 216 244 203",
  "M244 203C296 213 299 142 364 123",
  "M364 123C333 71 274 61 224 83"
] as const

const HillIsland = ({ x, y, name, mounds, scale = 1, children }: {
  readonly x: number
  readonly y: number
  readonly name: string
  readonly mounds: 1 | 2
  readonly scale?: number
  readonly children?: ReactNode
}): ReactElement => (
  <g transform={`translate(${x} ${y})`}>
    <g transform={`scale(${scale})`}>
      <path className="ship-hill-outline" d={mounds === 1
        ? "M-49 0C-33-2-31-34-5-34C22-34 31-5 49 0Q3 10-49 0Z"
        : "M-49 0C-40-5-39-25-25-31C-10-39-1-18 9-17C21-35 39-24 49 0Q3 10-49 0Z"} />
      <path className="ship-hill-ridge" d={mounds === 1
        ? "M-5-34Q-3-20 11-11M-32-4Q-20 1-10 0"
        : "M-25-31C-17-27-14-12-5 0M9-17Q19-12 24 2"} />
      <path className="ship-hill-hatching" d={mounds === 1
        ? "M-28-12l5 9M-23-19l8 15M-17-25l11 21M-10-28L3-4M-3-28L10-4M5-25L17-4M14-20l9 16M23-12l5 8"
        : "M-35-11l5 8M-30-20l9 17M-23-25l11 21M-15-22L-5-4M-7-15l6 11M13-16l7 13M20-20l9 17M28-16l7 13M36-8l3 5"} />
      <g className="ship-island-artifacts">{children}</g>
      <path className="ship-hill-water" d="M-55 12Q-30 17-13 14M5 16Q35 18 56 11M-29 23Q-13 26 3 23" />
    </g>
    <text className="ship-island-label" y="43">{name}</text>
  </g>
)

const IslandPalm = ({ x, y, scale = 1 }: { readonly x: number; readonly y: number; readonly scale?: number }): ReactElement => (
  <g transform={`translate(${x} ${y}) scale(${scale})`}>
    <path d="M0 4Q5-6 0-18M0-18Q-12-28-18-17M0-18Q10-31 19-21M0-18Q-13-19-15-6M0-18Q13-20 16-7M0-18Q3-30 0-32" />
  </g>
)

export const ShipPositionDiagram = (): ReactElement => {
  const [selected, setSelected] = useState(moves.length - 1)
  const history = moves.slice(0, selected + 1)
  const current = history.at(-1)!
  const totalDistance = history.reduce((distance, event, index) => {
    const previous = history[index - 1]
    return previous === undefined ? distance : distance + Math.hypot(event.x - previous.x, event.y - previous.y)
  }, 0)
  const elapsedMinutes = (current.at - history[0]!.at) / 60_000
  const [shipX, shipY] = mapPoint(current)
  const progress = { "--replay-progress": `${selected / (moves.length - 1) * 100}%`, "--ship-event-count": moves.length } as CSSProperties
  return (
    <figure className="ship-projection">
      <div className="ship-projection-body">
        <div className="ship-events">
          <div className="ship-events-heading"><span className="ship-projection-label">Event log</span><span>{selected + 1} / {moves.length}</span></div>
          <div className="ship-event-replay" style={progress}>
            <input className="ship-replay-slider" type="range" min={0} max={moves.length - 1} step={1} value={selected} aria-label="Replay ship events" aria-valuetext={`Event ${selected + 1}: PositionUpdated to ${current.spot}`} onChange={(event) => setSelected(Number(event.target.value))} />
            <div className="ship-event-list">
              {moves.map((event, index) => (
                <button key={event.spot} type="button" aria-pressed={index === selected} aria-label={`Replay event ${index + 1}: PositionUpdated to ${event.spot}`} onClick={() => setSelected(index)} data-future={index > selected}>
                  <span className="ship-event-number">{index + 1}</span>
                  <span className="ship-event-fields">
                    <span className="ship-event-title"><strong>{event.type}</strong><time dateTime={new Date(event.at).toISOString()}>{new Date(event.at).toISOString().slice(11, 16)}Z</time></span>
                    <code>{`spot: "${event.spot}"`}</code>
                    <code>{`x: ${event.x}, y: ${event.y}`}</code>
                  </span>
                </button>
              ))}
            </div>
          </div>
          <span className="ship-replay-hint">Drag to replay the log</span>
        </div>
        <div className="ship-world">
          <div className="ship-current" aria-live="polite" aria-atomic="true">
            <span className="ship-projection-label">Current location</span>
            <span className="ship-location-value"><code>{`"${current.spot}"`}</code><code>{`x: ${current.x}, y: ${current.y}`}</code></span>
            <span className="ship-projection-label">Total distance</span>
            <code title="Sum of straight-line distances between recorded positions">{totalDistance.toFixed(1)} km</code>
            <span className="ship-projection-label">Elapsed time</span>
            <code>{elapsedMinutes} min</code>
          </div>
          <svg viewBox="0 0 460 350" role="img" aria-label={`A sea chart with Harbor, Palm Cove, Gull Island, and North Bay. After event ${selected + 1}, the ship is at ${current.spot}.`}>
            <g className="ship-sea-waves" aria-hidden="true">
              {[[50, 72], [104, 136], [48, 179], [167, 175], [302, 44], [398, 75], [312, 300], [402, 259], [179, 321], [61, 319]].map(([x, y]) => (
                <g key={`${x}-${y}`} transform={`translate(${x} ${y})`}><path d="M-12 0q6 5 12 0t12 0M-6 8q6 4 12 0" /></g>
              ))}
            </g>
            <g className="ship-islands" aria-hidden="true">
              <HillIsland x={68} y={264} name="Harbor" mounds={1}>
                <path transform="translate(0 -28)" d="M-22-4V-16H-8V-4ZM-25-16L-15-24-5-16M3 0V-10H15V0ZM0-10L9-17 18-10M-17-4V-10H-13V-4" />
                <path d="M39 2H60M39 8H60M44-1V11M54-1V11" />
              </HillIsland>
              <HillIsland x={276} y={276} name="Palm Cove" mounds={2} scale={1.1}>
                <IslandPalm x={-23} y={-35} scale={.8} />
                <IslandPalm x={25} y={-26} scale={.6} />
              </HillIsland>
              <HillIsland x={394} y={179} name="Gull Island" mounds={2} scale={.8} />
              <HillIsland x={174} y={76} name="North Bay" mounds={1} scale={.95}>
                <g transform="translate(-5 -32)">
                  <path d="M-5 0L-3-25H4L6 0ZM-5-25H6V-32H-5ZM-8-32L0-41 9-32M-1-18H2V-12H-1Z" />
                  <path className="ship-lighthouse-rays" d="M-9-30L-43-42M-13-28H-38M-9-26L-43-14M10-30L44-42M14-28H39M10-26L44-14" />
                </g>
              </HillIsland>
            </g>
            <g className="ship-route" aria-hidden="true">
              {legs.slice(0, selected).map((path) => <path key={path} d={path} />)}
            </g>
            {history.map((event) => {
              const [x, y] = mapPoint(event)
              return <circle className="ship-visited" key={event.spot} cx={x} cy={y} r="3" />
            })}
            <g className="ship-marker" transform={`translate(${shipX} ${shipY - 26})`} aria-hidden="true">
              <ellipse className="ship-wake" cy="14" rx="25" ry="8" />
              <path className="ship-hull" d="M-19 5H19L12 15H-11Z" />
              <path className="ship-sail" d="M0-23V2H-16ZM4-18L17 2H4Z" />
              <path className="ship-mast" d="M0-26V6" />
              <path className="ship-sketch" d="M-12 8l2 4M-7 8l2 4M-2 8l2 4M3 8l2 4M8 8l2 4M-5-11V0M-8-6V0M7-9V0M10-4V0" />
            </g>
          </svg>
        </div>
      </div>
      <figcaption>The log records the journey. Its projection tells us where the ship is.</figcaption>
    </figure>
  )
}
