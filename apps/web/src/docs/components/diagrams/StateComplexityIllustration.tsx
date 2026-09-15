import { useId, type ReactElement } from "react"

const layers = [2, 3, 5, 7, 9, 11] as const
const nodes = layers.flatMap((count, column) => Array.from({ length: count }, (_, row) => ({
  id: `${column}-${row}`,
  column,
  row,
  x: 55 + column * 118 + Math.sin(row * 2 + column) * 8,
  y: 190 + (row - (count - 1) / 2) * (column < 2 ? 62 : 30),
  active: row === Math.floor(count / 2)
})))
const edges = nodes.flatMap((node) => {
  const next = nodes.filter((candidate) => candidate.column === node.column + 1)
  if (next.length === 0) return []
  const center = Math.round(node.row / Math.max(1, layers[node.column]! - 1) * (next.length - 1))
  return next.filter((candidate) => Math.abs(candidate.row - center) <= 1 || (node.active && candidate.active)).map((target) => ({ from: node, to: target, active: node.active && target.active }))
})

export const StateComplexityIllustration = (): ReactElement => {
  const arrow = useId()
  return (
    <svg className="state-complexity-art" viewBox="0 0 720 390" role="img" aria-label="An abstract state machine growing from a few states into dozens of interconnected states, with branching paths and loops.">
      <defs><marker id={arrow} viewBox="0 0 6 6" refX="5" refY="3" markerWidth="4" markerHeight="4" orient="auto"><path d="m1 1 4 2-4 2" /></marker></defs>
      <g className="state-complexity-links">
        {edges.map(({ from, to, active }) => {
          const angle = Math.atan2(to.y - from.y, to.x - from.x)
          const dx = Math.cos(angle)
          const dy = Math.sin(angle)
          return <path key={`${from.id}-${to.id}`} data-active={active} markerEnd={`url(#${arrow})`} d={`M${from.x + dx * 10} ${from.y + dy * 10}C${from.x + 50} ${from.y} ${to.x - 50} ${to.y} ${to.x - dx * 13} ${to.y - dy * 13}`} />
        })}
        {[2, 3, 4, 5].map((column) => {
          const top = nodes.find((node) => node.column === column && node.row === 0)!
          const bottom = nodes.find((node) => node.column === column && node.row === layers[column]! - 1)!
          return <path key={`loop-${column}`} className="state-complexity-loop" markerEnd={`url(#${arrow})`} d={`M${bottom.x + 8} ${bottom.y + 5}C${bottom.x + 85} ${bottom.y + 38} ${top.x + 85} ${top.y - 38} ${top.x + 12} ${top.y - 4}`} />
        })}
      </g>
      <g className="state-complexity-nodes">
        {nodes.map((node) => <g key={node.id} data-active={node.active}>
          <circle cx={node.x} cy={node.y} r={node.active ? 10 : 8} />
          {node.column === layers.length - 1 && node.row % 3 === 0 && <circle cx={node.x} cy={node.y} r="5" />}
        </g>)}
      </g>
    </svg>
  )
}
