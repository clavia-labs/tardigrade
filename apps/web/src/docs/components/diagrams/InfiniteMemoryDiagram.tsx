import type { ReactElement } from "react"

export const InfiniteMemoryDiagram = (): ReactElement => (
  <svg
    className="infinite-memory-diagram"
    viewBox="0 0 200 200"
    role="img"
    aria-label="The latest events are highlighted at the bottom of a longer event log."
  >
    <rect className="infinite-memory-frame" x="28" y="4" width="144" height="192" />
    <rect className="infinite-memory-window" x="28" y="118" width="144" height="78" />
    <g className="infinite-memory-rows" aria-hidden="true">
      <path d="M28 34H172M28 62H172M28 90H172M28 118H172M28 146H172M28 174H172" />
    </g>
    <g className="infinite-memory-events">
      <rect x="44" y="13" width="12" height="12" />
      <rect x="44" y="41" width="12" height="12" />
      <rect x="44" y="69" width="12" height="12" />
      <rect x="44" y="97" width="12" height="12" />
      <rect className="infinite-memory-event-active" x="44" y="125" width="12" height="12" />
      <rect className="infinite-memory-event-active" x="44" y="153" width="12" height="12" />
      <rect className="infinite-memory-event-active" x="44" y="181" width="12" height="12" />
    </g>
    <g className="infinite-memory-values" aria-hidden="true">
      <path d="M68 19H139M68 47H151M68 75H128M68 103H147M68 131H136M68 159H153M68 187H124" />
    </g>
  </svg>
)
