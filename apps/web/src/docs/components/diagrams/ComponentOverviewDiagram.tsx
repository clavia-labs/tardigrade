import { type ReactElement } from "react"

export const ComponentOverviewDiagram = (): ReactElement => (
  <figure className="component-overview component-overview-loop" aria-label="A component interacts with the world through effects and events">
    <svg viewBox="0 -35 800 345" role="img" aria-label="The component derives state and describes the next action as an Effect value. Both are on the pure side of a dashed boundary. Across the boundary, the runtime executes the description and performs I/O against the world. The result is recorded as an event and returns to the component.">
      <path d="M496 0V133M496 157V249" fill="none" stroke="var(--faint)" strokeWidth="1" strokeDasharray="4 5" opacity="0.65" />
      <g className="component-overview-globe">
        <circle className="globe-sphere" cx="728" cy="145" r="44" />
        <g className="globe-grid">
          <ellipse cx="728" cy="145" rx="17" ry="44" />
          <ellipse cx="728" cy="145" rx="32" ry="44" />
          <ellipse cx="728" cy="145" rx="44" ry="15" />
        </g>
      </g>
      <g className="component-overview-box">
        <rect x="24" y="92" width="232" height="106" />
        <text x="140" y="122">Component</text>
        <rect x="326" y="112" width="140" height="66" />
        <text x="396" y="150">Call model</text>
      </g>
      <g className="composition-links component-overview-links">
        <path d="M140 42V82m-5-8 5 8 5-8" />
        <path d="M266 145H316m-8-5 8 5-8 5" />
        <path d="M476 145H674m-8-5 8 5-8 5" />
        <path d="M728 199V261H140V208m-5 8 5-8 5 8" />
      </g>
      <g className="component-overview-labels" textAnchor="middle">
        <text x="484" y="18" textAnchor="end">Pure</text>
        <text x="508" y="18" textAnchor="start">Effectful</text>
        <text x="140" y="27">Event</text>
        <text x="140" y="151">derive state</text>
        <text x="140" y="173">describe next action</text>
        <text x="396" y="96">Effect value</text>
        <text x="396" y="204">description</text>
        <text x="593" y="122">runtime executes</text>
        <text x="593" y="175">I/O</text>
        <text x="728" y="82">World</text>
        <text x="434" y="287">result recorded as an event</text>
      </g>
    </svg>
  </figure>
)
