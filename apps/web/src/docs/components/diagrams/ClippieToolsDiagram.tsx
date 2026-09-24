import type { ReactElement } from "react"
import tardie from "../../../../../../assets/mascot/tardie-worker-with-wrench.svg"
import { FactoryGlyph } from "./FactoryPathsDiagram"

const tools = [
  { kind: "inspect", name: "Inspect water tank", y: 36 },
  { kind: "produce", name: "Produce paperclips", y: 114 },
  { kind: "treat", name: "Treat wastewater", y: 192 },
] as const

export const ClippieToolsDiagram = (): ReactElement => (
  <figure className="clippie-tools">
    <svg viewBox="0 0 860 280" role="img" aria-label="Clippy uses three tools to act on the world: Inspect water tank and Treat wastewater connect to the tank; Produce paperclips connects to the factory, which pipes waste to the tank">
      <text className="clippie-world-label" x="704" y="48" textAnchor="middle">World</text>
      <g className="clippie-tools-links" aria-hidden="true">
        <path d="M530 57h302v76h-21M530 135h68M530 213h302v-48h-21" />
        <path d="M816 129l-5 4 5 4M593 131l5 4-5 4M816 161l-5 4 5 4" />
      </g>
      <g className="clippie-factory-scene" transform="translate(580 65)" aria-hidden="true">
        <path className="clippie-factory-pipe" d="M144 96h16v7h20" />
        <path className="clippie-factory-building" d="M35 66V28h16v38" />
        <path className="clippie-factory-building" d="M24 115V71l40-19v19l40-19v19h40v44Z" />
        <path className="clippie-factory-detail" d="M36 86h13v13H36Zm25 0h13v13H61Zm25 0h13v13H86Z" />
        <path className="clippie-factory-detail" d="M115 115V89h17v26" />
        <path className="clippie-factory-tank" d="M180 52h45v64h-45Z" />
        <path className="clippie-factory-water" d="M183 80q5-3 10 0t10 0 10 0 9 0v33h-39Z" />
        <path className="clippie-factory-detail" d="M179 48h47m-43 15h39" />
        <path className="clippie-factory-level" d="M217 73h5m-5 12h5m-5 12h5" />
        <text className="clippie-scene-label" x="84" y="135" textAnchor="middle">Factory</text>
        <text className="clippie-scene-label" x="202" y="135" textAnchor="middle">Water tank</text>
      </g>
      <image href={tardie} x="8" y="49" width="220" height="158" />
      <text className="clippie-tools-name" x="118" y="232" textAnchor="middle">Clippy</text>
      <g className="clippie-tools-links">
        <path d="M221 135h37M258 57v156M258 57h45M258 135h45M258 213h45" />
        <circle cx="258" cy="135" r="3" />
      </g>
      {tools.map(({ kind, name, y }) => <g key={kind} transform={`translate(303 ${y})`}>
        <rect className="verification-tile" width="42" height="42" />
        <path className="verification-tile-light" d="M1 41V1h40l-5 5H6v30Z" />
        <path className="verification-tile-shadow" d="M1 41h40V1l-5 5v30H6Z" />
        <g className="factory-generated-icon" transform="translate(8 8) scale(.8125)"><FactoryGlyph kind={kind} /></g>
        <text className="clippie-tools-label" x="57" y="26">{name}</text>
      </g>)}
    </svg>
  </figure>
)
