import { useId, type ReactElement } from "react"

export const ThreadInvocationDiagram = (): ReactElement => {
  const arrow = useId()
  return (
    <svg className="actor-instances-diagram" viewBox="0 0 400 300" role="img" aria-label="A caller uses rickRef to invoke message with the idempotency key portal-plan. Rick's main thread returns the result. Retrying the action with the same key reuses the same call.">
      <defs>
        <marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0L8 4L0 8Z" />
        </marker>
      </defs>
      <g className="actor-instances-edges" aria-hidden="true">
        <path d="M158 78V190" markerEnd={`url(#${arrow})`} />
        <path d="M242 192V80" markerEnd={`url(#${arrow})`} />
      </g>
      <g transform="translate(132 12)">
        <rect width="136" height="66" rx="6" />
        <text x="68" y="28">Caller</text>
        <text className="actor-instances-label" x="68" y="49">holds rickRef</text>
      </g>
      <text className="actor-instances-label" x="76" y="118">message</text>
      <text className="actor-instances-label" x="76" y="140">idempotency key</text>
      <text className="actor-instances-label" x="76" y="158">“portal-plan”</text>
      <text className="actor-instances-label" x="300" y="138">result</text>
      <g transform="translate(132 192)">
        <rect width="136" height="66" rx="6" />
        <text className="actor-instances-label" x="68" y="24">tardie / rick</text>
        <text x="68" y="48">main</text>
      </g>
      <text className="actor-instances-label" x="200" y="286">Retry with the same key, reuse the same call</text>
    </svg>
  )
}
