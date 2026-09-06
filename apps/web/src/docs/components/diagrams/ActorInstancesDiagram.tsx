import { useId, type ReactElement } from "react"

export const ActorInstancesDiagram = ({ threads = false }: { threads?: boolean }): ReactElement => {
  const arrow = useId()
  return (
    <svg className="actor-instances-diagram" viewBox={`0 0 320 ${threads ? 330 : 220}`} role="img" aria-label={threads ? "The tardie actor definition has two instances. Rick and Morty each have their own main and lab threads." : "The tardie actor definition has two separate instances: Rick and Morty."}>
      <defs>
        <marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0L8 4L0 8Z" />
        </marker>
      </defs>
      <g className="actor-instances-edges" aria-hidden="true">
        <path d="M160 78V104H76V136" markerEnd={`url(#${arrow})`} />
        <path d="M160 104H244V136" markerEnd={`url(#${arrow})`} />
        {threads && <>
          <path d="M76 204V224H36V246" markerEnd={`url(#${arrow})`} />
          <path d="M76 224H116V246" markerEnd={`url(#${arrow})`} />
          <path d="M244 204V224H204V246" markerEnd={`url(#${arrow})`} />
          <path d="M244 224H284V246" markerEnd={`url(#${arrow})`} />
        </>}
      </g>
      <g transform="translate(92 12)">
        <rect width="136" height="66" rx="6" />
        <text className="actor-instances-label" x="68" y="24">Actor definition</text>
        <text x="68" y="48">tardie</text>
      </g>
      <g transform="translate(8 138)">
        <rect width="136" height="66" rx="6" />
        <text className="actor-instances-label" x="68" y="24">Instance</text>
        <text x="68" y="48">rick</text>
      </g>
      <g transform="translate(176 138)">
        <rect width="136" height="66" rx="6" />
        <text className="actor-instances-label" x="68" y="24">Instance</text>
        <text x="68" y="48">morty</text>
      </g>
      {threads && [{ x: 2, name: "main" }, { x: 82, name: "lab" }, { x: 170, name: "main" }, { x: 250, name: "lab" }].map(({ x, name }) => (
        <g key={x} transform={`translate(${x} 248)`}>
          <rect width="68" height="66" rx="6" />
          <text className="actor-instances-label" x="34" y="24">Thread</text>
          <text x="34" y="48">{name}</text>
        </g>
      ))}
    </svg>
  )
}
