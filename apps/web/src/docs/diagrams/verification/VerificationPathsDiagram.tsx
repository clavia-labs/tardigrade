import type { ReactElement } from "react"

type Tile = { readonly x: number; readonly y: number; readonly kind: "shared" | "safe" | "unsafe" }

const trails = [
  { kind: "shared", points: [[1, 8], [5, 8], [5, 4], [12, 4]] },
  { kind: "shared", points: [[5, 8], [5, 12], [10, 12]] },
  { kind: "safe", points: [[12, 4], [12, 1], [22, 1]] },
  { kind: "safe", points: [[12, 4], [18, 4], [18, 6], [26, 6]] },
  { kind: "unsafe", goal: true, points: [[12, 4], [12, 8], [26, 8], [26, 6]] },
  { kind: "safe", points: [[10, 12], [10, 11], [21, 11], [21, 10], [26, 10]] },
  { kind: "shared", points: [[10, 12], [10, 15], [16, 15]] },
  { kind: "unsafe", points: [[16, 15], [16, 13], [23, 13]] },
  { kind: "safe", points: [[16, 15], [16, 17], [27, 17]] },
] as const

const tiles = new Map<string, Tile>()
for (const { kind, points } of trails) {
  for (let segment = 1; segment < points.length; segment++) {
    const [startX, startY] = points[segment - 1]!
    const [endX, endY] = points[segment]!
    const length = Math.abs(endX - startX) + Math.abs(endY - startY)
    for (let step = 0; step <= length; step++) {
      const x = startX + Math.sign(endX - startX) * step
      const y = startY + Math.sign(endY - startY) * step
      const key = `${x},${y}`
      if (!tiles.has(key)) tiles.set(key, { x, y, kind })
    }
  }
}

export const VerificationPathsDiagram = (): ReactElement => (
  <figure className="verification-paths">
    <svg viewBox="0 0 700 460" role="img" aria-label="A smiling starting tile branches into Minesweeper-style paths. A blue path and a red path reach the same finish flag. The red path crosses a mine; another ends at a mine. Reaching a goal does not erase a rule violation.">
      {Array.from(tiles.values(), ({ x, y, kind }) => (
        <g key={`${x},${y}`} transform={`translate(${22 + x * 23} ${12 + y * 23})`}>
          <rect className="verification-tile" data-kind={kind} width="19" height="19" />
          <path className="verification-tile-light" d="M1 18V1h17l-3 3H4v11Z" />
          <path className="verification-tile-shadow" d="M1 18h17V1l-3 3v11H4Z" />
        </g>
      ))}
      <g transform="translate(54.5 205.5)">
        <circle className="verification-origin" r="8" />
        <path className="verification-face" d="M-4-4v2m8-2v2M-5 3l2 3h6l2-3" transform="scale(.68)" />
      </g>
      {trails.filter((trail) => trail.kind !== "shared" && !("goal" in trail && trail.goal)).map((trail) => {
        const { kind, points } = trail
        const [x, y] = points[points.length - 1]!
        return <g key={`${x},${y}`} className="verification-tile-mark" transform={`translate(${31.5 + x * 23} ${21.5 + y * 23})`}>
          {kind === "safe" ? <>
            <path d="M-3 6V-6m-3 12h8" />
            <path className="verification-flag" d="M-2-6h8v7h-8Z" />
            <path className="verification-flag-checks" d="M-2-6h4v3.5h-4Zm4 3.5h4V1H2Z" />
          </> : <>
            <path d="M0-7v14M-7 0H7M-5-5 5 5M5-5-5 5" />
            <circle className="verification-mine" r="4.5" />
            <rect className="verification-mine-glint" x="-2" y="-2" width="2" height="2" />
          </>}
        </g>
      })}
      <g className="verification-tile-mark" transform="translate(468.5 205.5)">
        <path d="M0-7v14M-7 0H7M-5-5 5 5M5-5-5 5" />
        <circle className="verification-mine" r="4.5" />
        <rect className="verification-mine-glint" x="-2" y="-2" width="2" height="2" />
      </g>
    </svg>
    <figcaption>Reaching the goal is not enough. The path there must respect the rule.</figcaption>
  </figure>
)
