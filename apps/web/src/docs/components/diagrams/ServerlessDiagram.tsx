import type { ReactElement } from "react"

const Cube = ({ active = false, x, y }: { readonly active?: boolean; readonly x: number; readonly y: number }): ReactElement => (
  <g className={`serverless-cube${active ? " serverless-cube-active" : ""}`} transform={`translate(${x} ${y})`}>
    <path className="serverless-cube-top" d="M0 8L14 0L28 8L14 16Z" />
    <path className="serverless-cube-left" d="M0 8L14 16V32L0 24Z" />
    <path className="serverless-cube-right" d="M14 16L28 8V24L14 32Z" />
  </g>
)

export const ServerlessDiagram = (): ReactElement => (
  <svg
    className="serverless-diagram"
    viewBox="0 0 200 200"
    role="img"
    aria-label="Small serverless workers form a connected graph."
  >
    <g className="serverless-graph" aria-hidden="true">
      <path d="M100 48L49 96L101 158L158 104L100 48Z" />
      <path d="M49 96L158 104" />
      <path d="M100 48L101 158" />
    </g>
    <Cube x={86} y={24} />
    <Cube x={35} y={80} />
    <Cube active x={144} y={88} />
    <Cube x={87} y={142} />
  </svg>
)
