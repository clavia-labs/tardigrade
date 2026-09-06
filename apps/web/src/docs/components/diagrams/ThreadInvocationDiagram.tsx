import { useId, type ReactElement } from "react"

export const ThreadInvocationDiagram = (): ReactElement => {
  const arrow = useId()
  return (
    <svg className="actor-instances-diagram" viewBox="0 0 320 250" role="img" aria-label="A caller uses rickRef to invoke message on tardie's main thread in Rick's instance. The thread returns a result to the caller.">
      <defs>
        <marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0L8 4L0 8Z" />
        </marker>
      </defs>
      <g className="actor-instances-edges" aria-hidden="true">
        <path d="M118 78V170" markerEnd={`url(#${arrow})`} />
        <path d="M202 172V80" markerEnd={`url(#${arrow})`} />
      </g>
      <g transform="translate(92 12)">
        <rect width="136" height="66" rx="6" />
        <text x="68" y="28">Caller</text>
        <text className="actor-instances-label" x="68" y="49">holds rickRef</text>
      </g>
      <text className="actor-instances-label" x="70" y="129">message</text>
      <text className="actor-instances-label" x="246" y="129">result</text>
      <g transform="translate(92 172)">
        <rect width="136" height="66" rx="6" />
        <text className="actor-instances-label" x="68" y="24">tardie / rick</text>
        <text x="68" y="48">main</text>
      </g>
    </svg>
  )
}
