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
      <path d="M96 55L57 88M104 55L150 93M56 108L95 146M151 112L107 145M63 97L144 103M100 56L101 142" />
    </g>
    <Cube x={86} y={24} />
    <Cube x={35} y={80} />
    <Cube active x={144} y={88} />
    <Cube x={87} y={142} />
  </svg>
)
