import type { ReactElement, ReactNode } from "react"

type Point = { readonly x: number; readonly y: number }

type PuzzleGridProps = {
  readonly children?: ReactNode
  readonly className?: string
  readonly pathClassName?: (row: number, column: number) => string | undefined
  readonly preserveAspectRatio?: string
  readonly rows: ReadonlyArray<string>
  readonly size?: number
  readonly tabRatio?: number
  readonly viewBox?: string
}

const pointAt = (start: Point, end: Point, normal: Point, progress: number, offset: number): Point => ({
  x: start.x + (end.x - start.x) * progress + normal.x * offset,
  y: start.y + (end.y - start.y) * progress + normal.y * offset
})

const coordinateOf = ({ x, y }: Point): string => `${x.toFixed(1)} ${y.toFixed(1)}`

const edge = (start: Point, end: Point, normal: Point, direction: number, tabRatio: number): string => {
  if (direction === 0) return `L ${coordinateOf(end)}`
  const depth = Math.hypot(end.x - start.x, end.y - start.y) * tabRatio * direction
  return [
    `L ${coordinateOf(pointAt(start, end, normal, 0.35, 0))}`,
    `C ${coordinateOf(pointAt(start, end, normal, 0.35, depth * 0.45))} ${coordinateOf(pointAt(start, end, normal, 0.39, depth))} ${coordinateOf(pointAt(start, end, normal, 0.5, depth))}`,
    `C ${coordinateOf(pointAt(start, end, normal, 0.61, depth))} ${coordinateOf(pointAt(start, end, normal, 0.65, depth * 0.45))} ${coordinateOf(pointAt(start, end, normal, 0.65, 0))}`,
    `L ${coordinateOf(end)}`
  ].join(" ")
}

const directionAt = (row: number, column: number, axis: number): number => (Math.abs(row * 31 + column * 17 + axis * 13) % 2 === 0 ? 1 : -1)

const pathAt = (rows: ReadonlyArray<string>, row: number, column: number, size: number, tabRatio: number): string => {
  const occupied = (candidateRow: number, candidateColumn: number): boolean => rows[candidateRow]?.[candidateColumn] === "1"
  const left = column * size
  const top = row * size
  const right = left + size
  const bottom = top + size
  return [
    `M ${left} ${top}`,
    edge({ x: left, y: top }, { x: right, y: top }, { x: 0, y: -1 }, occupied(row - 1, column) ? -directionAt(row - 1, column, 0) : 0, tabRatio),
    edge({ x: right, y: top }, { x: right, y: bottom }, { x: 1, y: 0 }, occupied(row, column + 1) ? directionAt(row, column, 1) : 0, tabRatio),
    edge({ x: right, y: bottom }, { x: left, y: bottom }, { x: 0, y: 1 }, occupied(row + 1, column) ? directionAt(row, column, 0) : 0, tabRatio),
    edge({ x: left, y: bottom }, { x: left, y: top }, { x: -1, y: 0 }, occupied(row, column - 1) ? -directionAt(row, column - 1, 1) : 0, tabRatio),
    "Z"
  ].join(" ")
}

export const PuzzleGrid = ({ children, className, pathClassName, preserveAspectRatio, rows, size = 20, tabRatio = 0.25, viewBox }: PuzzleGridProps): ReactElement => {
  const columns = Math.max(0, ...rows.map((row) => row.length))
  return (
    <svg aria-hidden="true" className={className} preserveAspectRatio={preserveAspectRatio} viewBox={viewBox ?? `0 0 ${columns * size} ${rows.length * size}`}>
      {children}
      {rows.flatMap((row, rowIndex) => [...row].map((cell, columnIndex) => cell === "1" ? <path className={pathClassName?.(rowIndex, columnIndex)} d={pathAt(rows, rowIndex, columnIndex, size, tabRatio)} key={`${rowIndex}-${columnIndex}`} /> : null))}
    </svg>
  )
}
