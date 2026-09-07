import { useId, type ReactElement } from "react"

export const ChildThreadsDiagram = (): ReactElement => {
  const arrow = useId()
  return (
    <div className="child-threads-comparison">
      {(["Logical", "Physical"] as const).map((view) => {
        const logical = view === "Logical"
        const marker = `${arrow}-${view}`
        const threads = logical
          ? [{ x: 48, y: 130, width: 136, name: "main" }, { x: 296, y: 130, width: 136, name: "lab" }, { x: 48, y: 234, width: 136, name: "researcher" }, { x: 48, y: 338, width: 136, name: "meeseeks" }]
          : [{ x: 4, y: 130, width: 108, name: "main" }, { x: 128, y: 130, width: 108, name: "researcher" }, { x: 252, y: 130, width: 108, name: "meeseeks" }, { x: 376, y: 130, width: 108, name: "lab" }]
        return (
          <figure key={view}>
            <figcaption>{view}</figcaption>
            <svg className="actor-instances-diagram" viewBox="0 0 488 424" role="img" aria-label={logical ? "Logical hierarchy: Rick's instance has main and lab threads. Researcher is a child of main, and Meeseeks is a child of researcher." : "Physical layout: main, researcher, meeseeks, and lab are separate threads in Rick's instance. Main creates researcher, and researcher creates meeseeks."}>
              <defs>
                <marker id={marker} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0 0L8 4L0 8Z" />
                </marker>
              </defs>
              <g className="actor-instances-edges" aria-hidden="true">
                {logical ? <>
                  <path d="M244 90V110H116V128" markerEnd={`url(#${marker})`} />
                  <path d="M244 110H364V128" markerEnd={`url(#${marker})`} />
                  <path d="M116 196V232" markerEnd={`url(#${marker})`} />
                  <path d="M116 300V336" markerEnd={`url(#${marker})`} />
                </> : <>
                  <path d="M244 90V110H58V128" markerEnd={`url(#${marker})`} />
                  <path d="M244 110H182V128" markerEnd={`url(#${marker})`} />
                  <path d="M244 110H306V128" markerEnd={`url(#${marker})`} />
                  <path d="M244 110H430V128" markerEnd={`url(#${marker})`} />
                  <path d="M58 196V228H166V198" markerEnd={`url(#${marker})`} />
                  <path d="M198 196V272H306V198" markerEnd={`url(#${marker})`} />
                </>}
              </g>
              <g transform="translate(176 24)">
                <rect width="136" height="66" rx="6" />
                <text className="actor-instances-label" x="68" y="24">Instance</text>
                <text x="68" y="48">rick</text>
              </g>
              {!logical && <>
                <text className="actor-instances-label" x="112" y="246">creates</text>
                <text className="actor-instances-label" x="252" y="290">creates</text>
              </>}
              {threads.map(({ x, y, width, name }) => (
                <g key={name} transform={`translate(${x} ${y})`}>
                  <rect width={width} height="66" rx="6" />
                  <text className="actor-instances-label" x={width / 2} y="24">Thread</text>
                  <text x={width / 2} y="48">{name}</text>
                </g>
              ))}
            </svg>
          </figure>
        )
      })}
    </div>
  )
}
