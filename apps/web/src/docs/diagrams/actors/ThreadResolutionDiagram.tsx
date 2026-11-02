import { useId, type ReactElement } from "react"

export const ThreadResolutionDiagram = (): ReactElement => {
  const arrow = useId()
  return (
    <svg className="actor-instances-diagram" viewBox="0 0 400 240" role="img" aria-label="On the left, rickMain branches right to two alternative placements: an edge server above and a local computer below. Each holds Rick's main thread.">
      <defs>
        <marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M1 1L7 4L1 7Z" />
        </marker>
      </defs>
      <text x="70" y="114">rickMain</text>
      <text className="actor-instances-label" x="70" y="136">host resolves</text>
      <g className="actor-instances-edges" aria-hidden="true">
        <path d="M120 120H150C185 120 180 60 216 60" markerEnd={`url(#${arrow})`} />
        <path d="M150 120C185 120 180 180 216 180" markerEnd={`url(#${arrow})`} />
      </g>
      <g transform="translate(220 24)">
        <rect width="150" height="72" rx="12" />
        <text className="actor-instances-label" x="75" y="28">Edge server</text>
        <text x="75" y="52">rick / main</text>
      </g>
      <text className="actor-instances-label" x="295" y="124">or</text>
      <g transform="translate(220 144)">
        <rect width="150" height="72" rx="12" />
        <text className="actor-instances-label" x="75" y="28">Local computer</text>
        <text x="75" y="52">rick / main</text>
      </g>
    </svg>
  )
}
