import { useId, type ReactElement } from "react"

// seeded returns a deterministic generator so the layout is identical across server and client renders.
const seeded = (seed: number): (() => number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const random = seeded(7)
const layers = [2, 3, 5, 7, 9, 11] as const
// activeRows is the highlighted trajectory, one row per column, wandering instead of holding the middle.
const activeRows = [1, 0, 2, 4, 3, 6] as const

type Node = { readonly id: string; readonly column: number; readonly row: number; readonly x: number; readonly y: number; readonly active: boolean }

const nodes: ReadonlyArray<Node> = layers.flatMap((count, column) => Array.from({ length: count }, (_, row) => ({
  id: `${column}-${row}`,
  column,
  row,
  x: 55 + column * 118 + (random() - 0.5) * 34,
  y: 195 + (row - (count - 1) / 2) * (column < 2 ? 62 : 31) + (random() - 0.5) * 16,
  active: row === activeRows[column]
})))

const at = (column: number, row: number): Node => nodes.find((node) => node.column === column && node.row === row)!

type Edge = { readonly from: Node; readonly to: Node; readonly active: boolean; readonly back: boolean }

const forward: ReadonlyArray<Edge> = nodes.flatMap((node) => {
  if (node.column === layers.length - 1) return []
  const next = layers[node.column + 1]!
  const center = Math.round(node.row / Math.max(1, layers[node.column]! - 1) * (next - 1))
  const spread = 1 + Math.floor(random() * 3)
  const targets = new Set<number>()
  for (let offset = -spread; offset <= spread; offset += 1) {
    if (random() < 0.7) targets.add(Math.min(next - 1, Math.max(0, center + offset)))
  }
  if (random() < 0.35) targets.add(Math.floor(random() * next))
  if (node.active) targets.add(activeRows[node.column + 1]!)
  return [...targets].map((row) => {
    const to = at(node.column + 1, row)
    return { from: node, to, active: node.active && to.active, back: false }
  })
})

// skips jump a column, which no tidy layer diagram allows.
const skips: ReadonlyArray<Edge> = nodes.flatMap((node) => {
  if (node.column >= layers.length - 2 || random() > 0.18) return []
  const to = at(node.column + 2, Math.floor(random() * layers[node.column + 2]!))
  return [{ from: node, to, active: false, back: true }]
})

// backs return to an earlier column, the loops that make the machine hard to hold in your head.
const backs: ReadonlyArray<Edge> = Array.from({ length: 9 }, () => {
  const fromColumn = 2 + Math.floor(random() * 4)
  const toColumn = Math.max(0, fromColumn - 1 - Math.floor(random() * 3))
  const from = at(fromColumn, Math.floor(random() * layers[fromColumn]!))
  const to = at(toColumn, Math.floor(random() * layers[toColumn]!))
  return { from, to, active: false, back: true }
})

// connected adds the edges that keep every state reachable and every non-terminal state leaving somewhere.
const connected: ReadonlyArray<Edge> = nodes.flatMap((node) => {
  const added: Array<Edge> = []
  if (node.column > 0 && !forward.some((edge) => edge.to === node)) {
    const previous = layers[node.column - 1]!
    const from = at(node.column - 1, Math.round(node.row / Math.max(1, layers[node.column]! - 1) * (previous - 1)))
    added.push({ from, to: node, active: false, back: false })
  }
  if (node.column < layers.length - 1 && !forward.some((edge) => edge.from === node)) {
    const next = layers[node.column + 1]!
    const to = at(node.column + 1, Math.round(node.row / Math.max(1, layers[node.column]! - 1) * (next - 1)))
    added.push({ from: node, to, active: false, back: false })
  }
  return added
})

const edges = [...forward, ...connected, ...skips, ...backs]

const pathFor = ({ from, to, back }: Edge): string => {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  const start = `${from.x + dx * 10} ${from.y + dy * 10}`
  const end = `${to.x - dx * 13} ${to.y - dy * 13}`
  if (!back) return `M${start}C${from.x + 50} ${from.y} ${to.x - 50} ${to.y} ${end}`
  const bulge = (from.row % 2 === 0 ? -1 : 1) * (40 + Math.abs(to.x - from.x) * 0.25)
  return `M${start}C${from.x + 30} ${from.y + bulge} ${to.x - 30} ${to.y + bulge} ${end}`
}

export const StateComplexityIllustration = (): ReactElement => {
  const arrow = useId()
  return (
    <svg className="state-complexity-art" viewBox="0 0 720 400" role="img" aria-label="An abstract state machine growing from a few states into dozens of interconnected states, with branching paths and loops.">
      <defs><marker id={arrow} viewBox="0 0 6 6" refX="5" refY="3" markerWidth="4" markerHeight="4" orient="auto"><path d="m1 1 4 2-4 2" /></marker></defs>
      <g className="state-complexity-links">
        {edges.map((edge) => <path key={`${edge.from.id}-${edge.to.id}-${edge.back ? "b" : "f"}`} className={edge.back ? "state-complexity-loop" : undefined} data-active={edge.active} markerEnd={`url(#${arrow})`} d={pathFor(edge)} />)}
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
