import type { ReactElement } from "react"

type Point = readonly [number, number]
type Bounds = readonly [number, number, number, number]
const branches: Array<ReadonlyArray<Point>> = []
const pitch = 2.5
let seed = 73
const random = (): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 4294967296
}

const branch = (bounds: Bounds, count: number, horizontal: boolean, path: ReadonlyArray<Point>): void => {
  const [left, top, right, bottom] = bounds
  const point: Point = [Math.round((left + right) / 2), Math.round((top + bottom) / 2)]
  const next = [...path, point]
  if (count === 1) {
    branches.push(next)
    return
  }
  if (horizontal) {
    const split = (left + right) / 2
    branch([left, top, split, bottom], count / 2, false, next)
    branch([split, top, right, bottom], count / 2, false, next)
  } else {
    const split = (top + bottom) / 2
    branch([left, top, right, split], count / 2, true, next)
    branch([left, split, right, bottom], count / 2, true, next)
  }
}

branch([0, 0, 256, 160], 256, true, [])

// spacedAxis preserves coordinate order so jitter cannot cross separate branches.
const spacedAxis = (axis: 0 | 1): Map<number, number> => {
  const values = [...new Set(branches.flatMap(path => path.map(point => point[axis])))].sort((a, b) => a - b)
  const positions = [0]
  for (let index = 1; index < values.length; index++) {
    positions.push(positions[index - 1]! + .7 + random() * .6)
  }
  const first = values[0]!
  const span = values.at(-1)! - first
  return new Map(values.map((value, index) => [
    value, Math.round(first + positions[index]! / positions.at(-1)! * span),
  ]))
}
const xPositions = spacedAxis(0)
const yPositions = spacedAxis(1)
const possiblePaths = branches.map(path => path.map(([x, y]): Point => [xPositions.get(x)!, yPositions.get(y)!]))
const center = possiblePaths[0]![0]!
const groups = Array.from({ length: 64 }, (_, index) => ({ index, score: random() }))
const sampledGroups = new Set(groups.sort((a, b) => a.score - b.score).slice(0, 16).map(group => group.index))
const sampledPaths = possiblePaths.filter((_, index) => sampledGroups.has(Math.floor(index / 4)))
const unsampledPaths = possiblePaths.filter((_, index) => !sampledGroups.has(Math.floor(index / 4)))
const sampledNodes = new Set(sampledPaths.flatMap(path => path.map(point => point.join(","))))
const unsafePaths = [0.12, 0.38, 0.66, 0.9].map(position => {
  const path = unsampledPaths[Math.floor(position * (unsampledPaths.length - 1))]!
  const firstUnvisited = path.findIndex(point => !sampledNodes.has(point.join(",")))
  return path.slice(firstUnvisited - 1)
})

const coordinates = (paths: ReadonlyArray<ReadonlyArray<Point>>): Set<string> => {
  const tiles = new Set<string>()
  for (const points of paths) {
    for (let segment = 1; segment < points.length; segment++) {
      const [startX, startY] = points[segment - 1]!
      const [endX, endY] = points[segment]!
      const steps = Math.abs(endX - startX) + Math.abs(endY - startY)
      for (let step = 0; step <= steps; step++) {
        const x = startX + Math.sign(endX - startX) * step
        const y = startY + Math.sign(endY - startY) * step
        tiles.add(`${x},${y}`)
      }
    }
  }
  return tiles
}
const allTiles = coordinates(possiblePaths)
const sampledTiles = coordinates(sampledPaths)
const unsafeTiles = coordinates(unsafePaths)

export const StateSpaceSamplingDiagram = (): ReactElement => (
  <figure className="state-space-sampling">
    <svg viewBox="0 0 664 424" role="img" aria-label="256 possible paths spread from the center in a rectangular tree of right-angle branches. 64 paths, exactly 25 percent, are sampled in blue. A few unsampled paths end in red unsafe branches.">
      {Array.from(allTiles, key => {
        const [x, y] = key.split(",").map(Number)
        return <rect key={key} className="state-space-tile" data-sampled={sampledTiles.has(key)} data-unsafe={unsafeTiles.has(key) && !sampledTiles.has(key)} x={12 + x! * pitch} y={12 + y! * pitch} width="1.8" height="1.8" />
      })}
      <g className="state-space-start" transform={`translate(${12 + center[0] * pitch + .9} ${12 + center[1] * pitch + .9})`}><circle r="2.2" /></g>
    </svg>
  </figure>
)
