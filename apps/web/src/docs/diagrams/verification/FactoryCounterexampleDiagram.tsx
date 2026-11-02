import type { ReactElement } from "react"
import { FactoryGlyph, ResourceGrid } from "./FactoryPathsDiagram"

const steps = [
  { kind: "inspect", label: "Inspect", water: 0, spill: 0, clips: 0 },
  { kind: "produce", label: "Batch A", water: 6, spill: 0, clips: 500 },
  { kind: "produce", label: "Batch B", water: 10, spill: 2, clips: 1000 },
] as const

export const FactoryCounterexampleDiagram = (): ReactElement => (
  <figure className="factory-counterexample">
    <svg className="factory-counterexample-desktop" viewBox="0 0 460 180" role="img" aria-label="One failing path: inspect an empty ten-unit tank, produce six units of waste, inspect again, then produce six more. The tank fills and two units spill outside.">
      {Array.from({ length: 13 }, (_, index) => {
        const x = 30 + index * 28
        return <g key={index} transform={`translate(${x} 32)`}>
          <rect className="verification-tile" data-kind={index >= 10 ? "unsafe" : "safe"} width="24" height="24" />
          <path className="verification-tile-light" d="M1 23V1h22l-3 3H4v16Z" />
          <path className="verification-tile-shadow" d="M1 23h22V1l-3 3v16H4Z" />
        </g>
      })}
      {steps.map(({ kind, label, water, spill, clips }, index) => <g key={label} transform={`translate(${30 + index * 140} 32)`}>
        <g className="factory-generated-icon" transform="translate(3 3) scale(.5625)"><FactoryGlyph kind={kind} /></g>
        <text className="factory-counterexample-label" x="12" y="-12" textAnchor="middle">{label}</text>
        <g transform="translate(-3 45)"><ResourceGrid water={water} spill={spill} clips={clips} /></g>
      </g>)}
      <g className="factory-generated-icon" transform="translate(257 35) scale(.5625)"><FactoryGlyph kind="inspect" /></g>
      <g className="verification-tile-mark" transform="translate(378 44)"><path d="M0-8v16M-8 0H8M-6-6 6 6M6-6-6 6" /><circle className="verification-mine" r="4" /></g>
      <text className="factory-counterexample-fail" x="403" y="48">FAIL</text>
    </svg>
    <svg className="factory-counterexample-mobile" viewBox="0 0 320 470" role="img" aria-label="A vertical failing path inspects the tank, produces batch A, inspects again, then produces batch B. The tank overflows by two units and the path ends at a mine.">
      {Array.from({ length: 13 }, (_, index) => <g key={index} transform={`translate(32 ${24 + index * 32})`}>
        <rect className="verification-tile" data-kind={index >= 10 ? "unsafe" : "safe"} width="24" height="24" />
        <path className="verification-tile-light" d="M1 23V1h22l-3 3H4v16Z" />
        <path className="verification-tile-shadow" d="M1 23h22V1l-3 3v16H4Z" />
      </g>)}
      {steps.map(({ kind, label, water, spill, clips }, index) => {
        const y = 24 + index * 160
        return <g key={label}>
          <g className="factory-generated-icon" transform={`translate(35 ${y + 3}) scale(.5625)`}><FactoryGlyph kind={kind} /></g>
          <text className="factory-counterexample-label" x="90" y={y + 14}>{label}</text>
          <g transform={`translate(90 ${y + 24})`}><ResourceGrid water={water} spill={spill} clips={clips} /></g>
        </g>
      })}
      <g className="factory-generated-icon" transform="translate(35 283) scale(.5625)"><FactoryGlyph kind="inspect" /></g>
      <g className="verification-tile-mark" transform="translate(44 420)"><path d="M0-8v16M-8 0H8M-6-6 6 6M6-6-6 6" /><circle className="verification-mine" r="4" /></g>
      <text className="factory-counterexample-fail" x="90" y="450">FAIL</text>
    </svg>
  </figure>
)
