import { useId, type ReactElement } from "react"

export const ActorCommunicationDiagram = (): ReactElement => {
  const arrow = useId()
  return (
    <div className="actor-communication-comparison">
    {(["People", "Actors"] as const).map((kind) => (
    <figure key={kind}>
    <svg className="actor-communication-diagram" viewBox="0 0 440 260" role="img" aria-label={`Five ${kind.toLowerCase()} communicating through matching network connections.`}>
      <defs>
        <marker id={`${arrow}-${kind}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0L8 4L0 8Z" />
        </marker>
      </defs>
      <g className="actor-communication-links" aria-hidden="true" markerStart={`url(#${arrow}-${kind})`} markerEnd={`url(#${arrow}-${kind})`}>
        <path d="M104 82L185 120" />
        <path d="M105 186L185 143" />
        <path d="M245 118L327 73" />
        <path d="M245 143L332 185" />
        <path d="M78 102L78 168" />
        <path d="M355 90L359 165" />
        <path d="M110 65Q220 4 325 54" />
      </g>
      {[
        { name: "A", x: 78, y: 70 },
        { name: "B", x: 78, y: 200 },
        { name: "C", x: 215, y: 132 },
        { name: "D", x: 354, y: 58 },
        { name: "E", x: 360, y: 197 },
      ].map(({ name, x, y }) => (
        <g key={name} transform={`translate(${x} ${y})`}>
          {kind === "People" ? <>
            <circle cy="-15" r="10" />
            <path className="actor-communication-person" d="M-21 25V15C-21 6-12 0 0 0S21 6 21 15V25Z" />
          </> : <>
            <circle r="30" />
            <text y="5">{name}</text>
          </>}
        </g>
      ))}
    </svg>
    <figcaption>{kind}</figcaption>
    </figure>
    ))}
    </div>
  )
}
