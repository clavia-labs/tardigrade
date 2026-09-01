import { Link, createRouter } from "@tanstack/react-router"
import type { ReactElement } from "react"

import { routeTree } from "./routeTree.gen"

const pixelRows = ["10010011111010010", "10010010001010010", "11111010001011111", "00010010001000010", "00010011111000010"]
const pieceSize = 20
const tabSize = 5

const pixelIsOn = (row: number, column: number): boolean => pixelRows[row]?.[column] === "1"

const horizontalEdge = (start: number, end: number, y: number, tab: number): string => {
  const direction = Math.sign(end - start)
  const neck = start + direction * 7
  const middle = start + direction * 10
  const farNeck = start + direction * 13
  return `L ${neck} ${y} C ${neck} ${y + tab * 0.45} ${middle - direction * 2.2} ${y + tab} ${middle} ${y + tab} C ${middle + direction * 2.2} ${y + tab} ${farNeck} ${y + tab * 0.45} ${farNeck} ${y} L ${end} ${y}`
}

const verticalEdge = (start: number, end: number, x: number, tab: number): string => {
  const direction = Math.sign(end - start)
  const neck = start + direction * 7
  const middle = start + direction * 10
  const farNeck = start + direction * 13
  return `L ${x} ${neck} C ${x + tab * 0.45} ${neck} ${x + tab} ${middle - direction * 2.2} ${x + tab} ${middle} C ${x + tab} ${middle + direction * 2.2} ${x + tab * 0.45} ${farNeck} ${x} ${farNeck} L ${x} ${end}`
}

const puzzlePath = (row: number, column: number): string => {
  const x = column * pieceSize
  const y = row * pieceSize
  const top = pixelIsOn(row - 1, column) ? horizontalEdge(x, x + pieceSize, y, (row + column) % 2 === 0 ? -tabSize : tabSize) : `L ${x + pieceSize} ${y}`
  const right = pixelIsOn(row, column + 1) ? verticalEdge(y, y + pieceSize, x + pieceSize, (row + column + 1) % 2 === 0 ? -tabSize : tabSize) : `L ${x + pieceSize} ${y + pieceSize}`
  const bottom = pixelIsOn(row + 1, column) ? horizontalEdge(x + pieceSize, x, y + pieceSize, (row + column + 1) % 2 === 0 ? -tabSize : tabSize) : `L ${x} ${y + pieceSize}`
  const left = pixelIsOn(row, column - 1) ? verticalEdge(y + pieceSize, y, x, (row + column) % 2 === 0 ? -tabSize : tabSize) : `L ${x} ${y}`
  return `M ${x} ${y} ${top} ${right} ${bottom} ${left} Z`
}

const NotFoundPage = (): ReactElement => (
  <main className="not-found-page">
    <div className="not-found-state">
      <svg aria-hidden="true" className="pixel-404" viewBox={`0 0 ${pixelRows[0].length * pieceSize} ${pixelRows.length * pieceSize}`}>
        {pixelRows.flatMap((row, rowIndex) => [...row].map((_, columnIndex) => pixelIsOn(rowIndex, columnIndex) ? <path d={puzzlePath(rowIndex, columnIndex)} key={`${rowIndex}-${columnIndex}`} /> : null))}
      </svg>
      <h1>Page not found</h1>
      <Link to="/docs">Go to docs</Link>
    </div>
  </main>
)

export const getRouter = () => createRouter({ routeTree, scrollRestoration: true, defaultNotFoundComponent: NotFoundPage })

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
