import { useId, type ReactElement } from "react"

export const ChildThreadsDiagram = (): ReactElement => {
  const arrow = useId()
  return (
    <svg className="actor-instances-diagram" viewBox="0 0 320 260" role="img" aria-label="Rick's instance contains main, researcher, and lab threads. Main creates researcher, whose name is scoped to main.">
      <defs>
        <marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0L8 4L0 8Z" />
        </marker>
      </defs>
      <g className="actor-instances-edges" aria-hidden="true">
        <path d="M160 78V104H52V128" markerEnd={`url(#${arrow})`} />
        <path d="M160 104V128" markerEnd={`url(#${arrow})`} />
        <path d="M160 104H268V128" markerEnd={`url(#${arrow})`} />
        <path d="M52 196V224H160V198" markerEnd={`url(#${arrow})`} />
      </g>
      <g transform="translate(92 12)">
        <rect width="136" height="66" rx="6" />
        <text className="actor-instances-label" x="68" y="24">Instance</text>
        <text x="68" y="48">rick</text>
      </g>
      {[{ x: 2, name: "main" }, { x: 110, name: "researcher" }, { x: 218, name: "lab" }].map(({ x, name }) => (
        <g key={name} transform={`translate(${x} 130)`}>
          <rect width="100" height="66" rx="6" />
          <text className="actor-instances-label" x="50" y="24">Thread</text>
          <text x="50" y="48">{name}</text>
        </g>
      ))}
      <text className="actor-instances-label" x="106" y="246">creates</text>
    </svg>
  )
}
