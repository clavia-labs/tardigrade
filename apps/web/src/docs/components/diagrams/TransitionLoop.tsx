import type { ReactElement } from "react"

type NodeProps = {
  readonly kind: "event" | "effect"
  readonly label: string
  readonly value: string
  readonly x: number
  readonly y: number
  readonly width?: number
}

const Node = ({ kind, label, value, width = 260, x, y }: NodeProps): ReactElement => (
  <g className={`transition-node transition-node-${kind}`} transform={`translate(${x} ${y})`}>
    <rect width={width} height="68" />
    <text className="transition-node-kind" x="14" y="22">{label}</text>
    <text className="transition-node-value" x="14" y="49">{value}</text>
  </g>
)

export const TransitionLoop = (): ReactElement => (
  <svg className="transition-loop" viewBox="0 0 720 640" role="img" aria-label="A received message enables model inference. A tool call enables a service effect whose result enables inference again. A final response completes the method call and the actor settles.">
    <defs>
      <marker id="transition-loop-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0 0L8 4L0 8Z" />
      </marker>
    </defs>

    <g className="transition-paths" aria-hidden="true">
      <path d="M210 98V150" />
      <path d="M340 176C374 176 396 154 430 154" />
      <path d="M540 188V250" />
      <path d="M540 318V390" />
      <path d="M430 424C378 424 392 236 340 202" />
      <path d="M210 218V440" />
      <path d="M210 508V562" />
    </g>

    <g className="transition-path-labels" aria-hidden="true">
      <text x="374" y="144">tool call</text>
      <text x="406" y="350">tool result</text>
      <text x="230" y="342">final response</text>
    </g>

    <Node kind="event" label="event" value="MessageReceived" x={80} y={30} />
    <Node kind="effect" label="effect transition" value="model.generate(messages)" x={80} y={150} />
    <Node kind="event" label="event" value="ToolCalled" x={430} y={120} width={220} />
    <Node kind="effect" label="effect transition" value="service.call(...)" x={430} y={250} width={220} />
    <Node kind="event" label="event" value="ToolReturned" x={430} y={390} width={220} />
    <Node kind="event" label="event" value="TurnCompleted" x={80} y={440} />
    <g className="transition-terminal" transform="translate(100 562)">
      <rect width="220" height="50" />
      <text x="110" y="30">settled</text>
    </g>
  </svg>
)
