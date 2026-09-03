import type { ReactElement } from "react"

export const ActorDiagram = (): ReactElement => (
  <svg
    className="actor-diagram"
    viewBox="0 0 720 640"
    role="img"
    aria-label="A caller interacts with an actor through methods. Methods append input events and expose call state. Component projections advance from events, produce views and transitions, and interact with external services through effects whose outcomes return as events."
  >
    <defs>
      <marker id="actor-diagram-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 0L8 4L0 8Z" />
      </marker>
    </defs>

    <rect className="actor-diagram-boundary" x="80" y="102" width="560" height="430" />
    <text className="actor-diagram-boundary-label" x="104" y="130">actor / researcher</text>

    <g className="actor-diagram-node actor-diagram-external" transform="translate(260 18)">
      <rect width="200" height="54" />
      <text x="100" y="33">Caller</text>
    </g>

    <g className="actor-diagram-node" transform="translate(210 148)">
      <rect width="300" height="68" />
      <text className="actor-diagram-node-kind" x="18" y="22">methods</text>
      <text className="actor-diagram-node-value" x="18" y="48">typed calls</text>
    </g>

    <g className="actor-diagram-log" transform="translate(170 270)">
      <rect className="actor-diagram-log-frame" width="380" height="120" />
      <text className="actor-diagram-node-kind" x="18" y="23">event log · audit-42</text>
      <g transform="translate(18 42)">
        <text x="0" y="12"><tspan>01</tspan><tspan x="34">MessageReceived</tspan></text>
        <text x="190" y="12"><tspan>02</tspan><tspan x="224">ToolCalled</tspan></text>
        <text x="0" y="42"><tspan>03</tspan><tspan x="34">ToolReturned</tspan></text>
        <text x="190" y="42"><tspan>04</tspan><tspan x="224">TurnCompleted</tspan></text>
      </g>
    </g>

    <g className="actor-diagram-node" transform="translate(210 444)">
      <rect width="300" height="68" />
      <text className="actor-diagram-node-kind" x="18" y="22">component projections</text>
      <text className="actor-diagram-node-value" x="18" y="48">views + transitions</text>
    </g>

    <g className="actor-diagram-node actor-diagram-external" transform="translate(230 568)">
      <rect width="260" height="54" />
      <text x="130" y="33">External services</text>
    </g>

    <g className="actor-diagram-connectors" aria-hidden="true">
      <path d="M360 72V148" />
      <path d="M360 216V270" />
      <path d="M360 390V444" />
      <path d="M360 512V568" />
    </g>

    <g className="actor-diagram-edge-labels" aria-hidden="true">
      <text x="380" y="92">call ↓ · result ↑</text>
      <text x="380" y="246">input event ↓ · call state ↑</text>
      <text x="380" y="420">events ↓ · output ↑</text>
      <text x="380" y="548">effect ↓ · outcome ↑</text>
    </g>
  </svg>
)
