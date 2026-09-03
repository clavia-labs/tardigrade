import type { ReactElement } from "react"

export const MethodDiagram = (): ReactElement => (
  <svg
    className="method-diagram"
    viewBox="0 0 720 776"
    role="img"
    aria-label="A caller makes a typed message call. The method validates it and appends a MessageReceived event. After the actor records TurnCompleted, the method derives a completed state and returns a typed result for the same call identifier."
  >
    <defs>
      <marker id="method-diagram-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0 0L8 4L0 8Z" />
      </marker>
    </defs>

    <g className="method-diagram-node method-diagram-endpoint" transform="translate(180 10)">
      <rect width="360" height="90" />
      <text className="method-diagram-kind" x="18" y="23">typed call · audit-42</text>
      <text className="method-diagram-value">
        <tspan x="18" y="50">{`message({`}</tspan>
        <tspan x="18" dy="21">{`  text: "Audit the deployment." })`}</tspan>
      </text>
    </g>

    <g className="method-diagram-node method-diagram-method" transform="translate(180 130)">
      <rect width="360" height="78" />
      <text className="method-diagram-kind" x="18" y="23">method · message</text>
      <text className="method-diagram-function" x="18" y="49">event(call)</text>
      <text className="method-diagram-detail" x="172" y="49">validates typed input</text>
    </g>

    <g className="method-diagram-node" transform="translate(210 248)">
      <rect width="300" height="78" />
      <text className="method-diagram-kind" x="18" y="23">event · appended to log</text>
      <text className="method-diagram-value" x="18" y="50">MessageReceived</text>
      <text className="method-diagram-detail" x="182" y="50">call · audit-42</text>
    </g>

    <g className="method-diagram-loop" transform="translate(250 366)">
      <rect width="220" height="54" />
      <text x="110" y="22">actor runs transitions</text>
      <text x="110" y="41">and records outcomes</text>
    </g>

    <g className="method-diagram-node" transform="translate(210 460)">
      <rect width="300" height="78" />
      <text className="method-diagram-kind" x="18" y="23">event · in the log</text>
      <text className="method-diagram-value" x="18" y="50">TurnCompleted</text>
      <text className="method-diagram-detail" x="166" y="50">call · audit-42</text>
    </g>

    <g className="method-diagram-node method-diagram-method" transform="translate(180 578)">
      <rect width="360" height="78" />
      <text className="method-diagram-kind" x="18" y="23">method · message</text>
      <text className="method-diagram-function" x="18" y="50">state(log, "audit-42")</text>
    </g>

    <g className="method-diagram-node method-diagram-endpoint" transform="translate(180 696)">
      <rect width="360" height="70" />
      <text className="method-diagram-kind" x="18" y="23">typed result · audit-42</text>
      <text className="method-diagram-value" x="18" y="50">completed({`{ output: string }`})</text>
    </g>

    <g className="method-diagram-connectors" aria-hidden="true">
      <path d="M360 100V130" />
      <path d="M360 208V248" />
      <path d="M360 326V366" />
      <path d="M360 420V460" />
      <path d="M360 538V578" />
      <path d="M360 656V696" />
    </g>
  </svg>
)
