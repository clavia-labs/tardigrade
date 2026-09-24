import type { ReactElement } from "react"
import { FactoryGlyph } from "./FactoryPathsDiagram"

const path = [
  ...Array.from({ length: 7 }, (_, x) => ({ x, y: 3, blocked: false })),
  { x: 6, y: 2, blocked: false },
  ...Array.from({ length: 5 }, (_, index) => ({ x: index + 6, y: 1, blocked: false })),
  ...Array.from({ length: 4 }, (_, index) => ({ x: index + 7, y: 3, blocked: true })),
]

const tilePosition = (x: number, y: number) => ({ x: 35 + x * 43, y: 12 + y * 43 })

export const FactoryDiversionDiagram = (): ReactElement => (
  <figure className="factory-diversion">
    <svg viewBox="0 0 580 230" role="img" aria-label="After inspecting and producing batch A, a second batch is blocked because six more units would exceed tank capacity. The blocked gray route continues to an unreachable mine. The safe tiled route diverts through wastewater treatment, then produces batch B and reaches the goal.">
      {path.map(({ x, y, blocked }) => {
        const at = tilePosition(x, y)
        return <g key={`${x},${y}`} transform={`translate(${at.x} ${at.y})`}>
          <rect className="verification-tile" data-kind={blocked ? "blocked" : "safe"} width="34" height="34" />
          <path className="verification-tile-light" d="M1 33V1h32l-5 5H6v22Z" />
          <path className="verification-tile-shadow" d="M1 33h32V1l-5 5v22H6Z" />
        </g>
      })}
      {([
        { x: 0, y: 3, kind: "inspect" },
        { x: 2, y: 3, kind: "produce" },
        { x: 6, y: 1, kind: "treat" },
        { x: 8, y: 1, kind: "produce" },
      ] as const).map(({ x, y, kind }) => {
        const at = tilePosition(x, y)
        return <g className="factory-diversion-icon" key={`${x},${y}`} transform={`translate(${at.x + 3} ${at.y + 3}) scale(.875)`}><FactoryGlyph kind={kind} /></g>
      })}
      <g className="factory-diversion-icon" transform="translate(293 141)"><path d="M8 8l18 18M26 8 8 26" /></g>
      <g className="factory-diversion-block" transform="translate(468 144) scale(.875)"><FactoryGlyph kind="mine" /></g>
      <g className="verification-tile-mark" transform="translate(482 72)"><path d="M-3 6V-6m-3 12h8" /><path className="verification-flag" d="M-2-6h8v7h-8Z" /><path className="verification-flag-checks" d="M-2-6h4v3.5h-4Zm4 3.5h4V1H2Z" /></g>
      <text className="factory-diversion-label" x="52" y="194" textAnchor="middle">Inspect</text>
      <text className="factory-diversion-label" x="138" y="194" textAnchor="middle">Batch A</text>
      <text className="factory-diversion-label" x="310" y="38" textAnchor="middle">Treat waste</text>
      <text className="factory-diversion-label" x="396" y="38" textAnchor="middle">Batch B</text>
      <text className="factory-diversion-label" x="310" y="194" textAnchor="middle">Batch denied</text>
      <text className="factory-diversion-note" x="310" y="211" textAnchor="middle">6 + 6 &gt; 10</text>
      <text className="factory-diversion-label" x="482" y="38" textAnchor="middle">Goal</text>
    </svg>
    <figcaption>The guard refuses the second batch until wastewater is treated.</figcaption>
  </figure>
)
