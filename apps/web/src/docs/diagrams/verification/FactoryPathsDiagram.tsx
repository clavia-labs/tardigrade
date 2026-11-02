import type { ReactElement } from "react"

type Icon = "inspect" | "produce" | "treat" | "mine"

export const FactoryGlyph = ({ kind }: { readonly kind: Icon }): ReactElement => (
  <>
    {kind === "inspect" ? <><circle cx="13" cy="13" r="8" /><path d="m19 19 9 9M9 13h8m-4-4v8" /></> : kind === "produce" ? <path d="m13 23 10-10a5 5 0 0 0-7-7L5 17a8 8 0 0 0 11 11L27 17M9 21 20 10a2 2 0 0 1 3 3L13 23" /> : kind === "treat" ? <><path d="M16 3C13 9 6 15 6 21a10 10 0 0 0 20 0C26 15 19 9 16 3Z" /><path d="m11 21 4 4 7-8" /></> : <><circle cx="16" cy="16" r="7" /><path d="M16 3v6m0 14v6M3 16h6m14 0h6M6 6l5 5m10 10 5 5M26 6l-5 5M11 21l-5 5" /><path d="M13 13h1" /></>}
  </>
)

const factoryTrails = [
  { unsafe: false, points: [[0, 3], [2, 3]] },
  { unsafe: false, points: [[2, 3], [2, 1], [10, 1], [10, 3]] },
  { unsafe: true, points: [[2, 3], [2, 5], [10, 5], [10, 3]] },
] as const
const factoryTiles = new Map<string, { readonly x: number; readonly y: number; readonly unsafe: boolean }>()
for (const { unsafe, points } of factoryTrails) {
  for (let index = 1; index < points.length; index++) {
    const [sx, sy] = points[index - 1]!
    const [ex, ey] = points[index]!
    const length = Math.abs(ex - sx) + Math.abs(ey - sy)
    for (let step = 0; step <= length; step++) {
      const x = sx + Math.sign(ex - sx) * step
      const y = sy + Math.sign(ey - sy) * step
      const key = `${x},${y}`
      if (!factoryTiles.has(key)) factoryTiles.set(key, { x, y, unsafe })
    }
  }
}

const ResourceCell = ({ x, y, kind, filled, spill = false }: { readonly x: number; readonly y: number; readonly kind: "water" | "clips"; readonly filled: boolean; readonly spill?: boolean }): ReactElement => (
  <g transform={`translate(${x} ${y})`}>
    <rect className={spill ? "factory-resource-spill" : "factory-resource-cell"} data-filled={filled} width="10" height="10" />
    <g className="factory-resource-symbol" data-filled={filled} transform="translate(1 1) scale(.25)">
      {kind === "water" ? <path d="M16 3C13 9 6 15 6 21a10 10 0 0 0 20 0C26 15 19 9 16 3Z" /> : <FactoryGlyph kind="produce" />}
    </g>
  </g>
)

export const ResourceGrid = ({ water, clips, spill = Math.max(0, water - 10), capacity = 10, clipGoal = 1_000 }: { readonly water: number; readonly clips: number; readonly spill?: number; readonly capacity?: number; readonly clipGoal?: number }): ReactElement => (
  <g className="factory-resource-grid" role="img" aria-label={`${Math.min(water, capacity)} of ${capacity} water units, ${spill} units spilled, ${clips} of ${clipGoal} paperclips`}>
    <g className="factory-resource-water" data-overflow={spill > 0}>
    <text className="factory-resource-label" x="0" y="15">Water</text>
    <g transform="translate(36 0)">
    {Array.from({ length: capacity }, (_, index) => <ResourceCell key={index} kind="water" filled={index < Math.min(water, capacity)} x={(index % 5) * 13} y={Math.floor(index / 5) * 13} />)}
    {Array.from({ length: spill }, (_, index) => <ResourceCell key={`spill-${index}`} kind="water" filled spill x={75 + (index % 2) * 13} y={Math.floor(index / 2) * 13} />)}
    {spill > 0 && <path className="factory-resource-divider" d="M68-2v27" />}
    </g>
    </g>
    <text className="factory-resource-label" x="0" y="48">Clips</text>
    <g transform="translate(36 0)">
    {Array.from({ length: 10 }, (_, index) => <ResourceCell key={`clips-${index}`} kind="clips" filled={index < clips / (clipGoal / 10)} x={(index % 5) * 13} y={33 + Math.floor(index / 5) * 13} />)}
    </g>
  </g>
)

const factoryStops = [
  { x: 0, y: 3, kind: "inspect", label: "Inspect", water: 0, clips: 0 },
  { x: 2, y: 3, kind: "produce", label: "Batch A", water: 6, clips: 500 },
  { x: 5, y: 1, kind: "treat", label: "Treat waste", water: 0, clips: 500 },
  { x: 8, y: 1, kind: "produce", label: "Batch B", water: 6, clips: 1000 },
  { x: 5, y: 5, kind: "produce", label: "Batch B", water: 12, clips: 1000 },
  { x: 8, y: 5, kind: "mine", label: "Overflow", water: 12, clips: 1000 },
] as const

const mobileStops = [
  { x: 159, y: 15, kind: "inspect", label: "Inspect", water: 0, clips: 0, gridX: 18, gridY: 8, labelX: 212, labelY: 42, unsafe: false },
  { x: 159, y: 105, kind: "produce", label: "Batch A", water: 6, clips: 500, gridX: 18, gridY: 98, labelX: 212, labelY: 132, unsafe: false },
  { x: 58, y: 220, kind: "treat", label: "Treat waste", water: 0, clips: 500, gridX: 15, gridY: 295, labelX: 79, labelY: 282, unsafe: false },
  { x: 239, y: 220, kind: "produce", label: "Batch B", water: 12, clips: 1000, gridX: 195, gridY: 295, labelX: 260, labelY: 282, unsafe: true },
  { x: 58, y: 390, kind: "produce", label: "Batch B", water: 6, clips: 1000, gridX: 15, gridY: 455, labelX: 79, labelY: 452, unsafe: false },
  { x: 239, y: 390, kind: "mine", label: "Overflow", water: 12, clips: 1000, gridX: 195, gridY: 455, labelX: 260, labelY: 452, unsafe: true },
] as const

export const FactoryToolsDiagram = (): ReactElement => (
  <figure className="factory-board">
    <svg className="factory-board-desktop" viewBox="0 -45 590 455" role="img" aria-label="A tiled path inspects the tank and produces batch A. The blue branch treats waste and inspects again before batch B. The red branch produces batch B without treatment and overflows. Both routes lead to the same goal of 1,000 paperclips.">
      {Array.from(factoryTiles.values(), ({ x, y, unsafe }) => <g key={`${x},${y}`} transform={`translate(${24 + x * 50} ${12 + y * 50})`}>
        <rect className="verification-tile" data-kind={unsafe ? "unsafe" : "safe"} width="42" height="42" />
        <path className="verification-tile-light" d="M1 41V1h40l-5 5H6v30Z" />
        <path className="verification-tile-shadow" d="M1 41h40V1l-5 5v30H6Z" />
      </g>)}
      {factoryStops.map(({ x, y, kind, label, water, clips }) => <g className="factory-board-stop" data-unsafe={y === 5} key={`${x},${y}`} transform={`translate(${24 + x * 50} ${12 + y * 50})`}>
        <g className="factory-board-icon" transform="translate(8 8) scale(0.8125)"><FactoryGlyph kind={kind} /></g>
        <text x={x === 2 ? 58 : 21} y={y === 1 ? -83 : x === 2 ? 18 : 62} textAnchor={x === 2 ? "start" : "middle"}>{label}</text>
        {kind !== "mine" && <g transform={`translate(${x === 2 ? 58 : -10} ${y === 1 ? -70 : x === 2 ? 30 : 75})`}><ResourceGrid water={water} clips={clips} /></g>}
      </g>)}
      <g className="factory-board-icon" transform="translate(382 70) scale(.8125)"><FactoryGlyph kind="inspect" /></g>
      <g className="verification-tile-mark" transform="translate(545 183) scale(2)">
        <path d="M-3 6V-6m-3 12h8" />
        <path className="verification-flag" d="M-2-6h8v7h-8Z" />
        <path className="verification-flag-checks" d="M-2-6h4v3.5h-4Zm4 3.5h4V1H2Z" />
      </g>
      <text className="factory-board-goal" x="512" y="187" textAnchor="end">1,000 clips</text>
    </svg>
    <svg className="factory-board-mobile" viewBox="0 0 360 630" role="img" aria-label="After inspection and batch A, a vertical blue route treats wastewater and inspects again before batch B. A parallel red route produces batch B without treatment and reaches an overflow mine.">
      <g className="factory-board-safe-link" aria-hidden="true">
        <path d="M180 57v48M180 147v38H79v35M58 241H8v125h71v24M58 411H8v157h172" />
      </g>
      <g className="factory-board-unsafe-link" aria-hidden="true">
        <path d="M180 185h80v35M281 241h71v170h-71M281 411h71v157H180" />
      </g>
      {mobileStops.map(({ x, y, kind, label, water, clips, gridX, gridY, labelX, labelY, unsafe }) => <g className="factory-board-stop" data-unsafe={unsafe} key={`${x},${y}`}>
        <g transform={`translate(${x} ${y})`}>
          <rect className="verification-tile" data-kind={unsafe ? "unsafe" : "safe"} width="42" height="42" />
          <path className="verification-tile-light" d="M1 41V1h40l-5 5H6v30Z" />
          <path className="verification-tile-shadow" d="M1 41h40V1l-5 5v30H6Z" />
          <g className="factory-board-icon" transform="translate(8 8) scale(.8125)"><FactoryGlyph kind={kind} /></g>
        </g>
        <text x={labelX} y={labelY} textAnchor={y < 200 ? "start" : "middle"}>{label}</text>
        <g transform={`translate(${gridX} ${gridY})`}><ResourceGrid water={water} clips={clips} /></g>
      </g>)}
      <g className="factory-board-stop" transform="translate(58 345)">
        <rect className="verification-tile" data-kind="safe" width="42" height="42" />
        <path className="verification-tile-light" d="M1 41V1h40l-5 5H6v30Z" />
        <path className="verification-tile-shadow" d="M1 41h40V1l-5 5v30H6Z" />
        <g className="factory-board-icon" transform="translate(8 8) scale(.8125)"><FactoryGlyph kind="inspect" /></g>
        <text x="50" y="25">Inspect</text>
      </g>
      <g className="verification-tile-mark" transform="translate(180 575) scale(2)">
        <path d="M-3 6V-6m-3 12h8" />
        <path className="verification-flag" d="M-2-6h8v7h-8Z" />
        <path className="verification-flag-checks" d="M-2-6h4v3.5h-4Zm4 3.5h4V1H2Z" />
      </g>
      <text className="factory-board-goal" x="180" y="612" textAnchor="middle">1,000 clips</text>
    </svg>
    <figcaption>One small cell = 1 water unit. Each paperclip cell = 100 clips; the full grid = 1,000 clips. Empty cells show remaining capacity; red cells outside the grid show spilled waste.</figcaption>
  </figure>
)
