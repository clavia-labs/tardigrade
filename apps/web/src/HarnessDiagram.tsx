import type { ReactElement } from "react"

export const HarnessDiagram = (): ReactElement => (
  <svg
    className="harness-diagram"
    viewBox="0 0 720 660"
    role="img"
    aria-label="An immutable event log is folded through a component tree. Components derive views and transitions. The runtime executes transitions and appends their outcome events to the log."
  >
    <defs>
      <marker id="harness-diagram-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0 0L8 4L0 8Z" />
      </marker>
    </defs>

    <g className="harness-diagram-node" transform="translate(210 20)">
      <rect width="300" height="92" />
      <text className="harness-diagram-kind" x="22" y="30">immutable event log</text>
      <text className="harness-diagram-value" x="22" y="64">e₁ · e₂ · e₃ · ... · eₙ</text>
    </g>

    <g className="harness-diagram-component" transform="translate(120 178)">
      <rect width="480" height="122" />
      <text className="harness-diagram-kind" x="24" y="31">component tree</text>
      <text className="harness-diagram-value" x="24" y="68">system + compaction + tools + output</text>
      <text className="harness-diagram-detail" x="24" y="98">state = fold(events, step)</text>
    </g>

    <g className="harness-diagram-node harness-diagram-view" transform="translate(30 390)">
      <rect width="300" height="92" />
      <text className="harness-diagram-kind" x="24" y="30">views</text>
      <text className="harness-diagram-value" x="24" y="64">context + tools + output</text>
    </g>

    <g className="harness-diagram-node harness-diagram-transition" transform="translate(390 390)">
      <rect width="300" height="92" />
      <text className="harness-diagram-kind" x="24" y="30">transitions</text>
      <text className="harness-diagram-value" x="24" y="64">intents + effects</text>
    </g>

    <g className="harness-diagram-node harness-diagram-runtime" transform="translate(390 560)">
      <rect width="300" height="74" />
      <text className="harness-diagram-kind" x="24" y="27">runtime</text>
      <text className="harness-diagram-value" x="24" y="55">execute enabled work</text>
    </g>

    <g className="harness-diagram-connectors" aria-hidden="true">
      <path d="M360 112V178" />
      <path d="M360 300V338H180V390" />
      <path d="M360 300V338H540V390" />
      <path d="M540 482V560" />
      <path d="M690 597H708V66H510" />
    </g>

    <g className="harness-diagram-boundary" aria-hidden="true">
      <text x="30" y="508">pure</text>
      <path d="M30 518H690" />
      <text x="30" y="540">effectful</text>
    </g>

    <g className="harness-diagram-labels" aria-hidden="true">
      <text x="378" y="148">events</text>
      <text x="192" y="362">output</text>
      <text x="552" y="362">enabled work</text>
      <text x="561" y="546">execute</text>
      <text x="608" y="53">append events</text>
    </g>
  </svg>
)
