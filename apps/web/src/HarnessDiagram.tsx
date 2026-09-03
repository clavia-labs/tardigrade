import type { ReactElement } from "react"

export const HarnessDiagram = (): ReactElement => (
  <svg
    className="harness-diagram"
    viewBox="0 0 720 520"
    role="img"
    aria-label="An immutable event log is folded through a component tree. Components derive views and transitions. The runtime executes transitions and appends their outcome events to the log."
  >
    <defs>
      <marker id="harness-diagram-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0 0L8 4L0 8Z" />
      </marker>
    </defs>

    <g className="harness-diagram-node" transform="translate(210 10)">
      <rect width="300" height="72" />
      <text className="harness-diagram-kind" x="22" y="25">immutable event log</text>
      <text className="harness-diagram-value" x="22" y="53">e₁ · e₂ · e₃ · ... · eₙ</text>
    </g>

    <g className="harness-diagram-component" transform="translate(120 126)">
      <rect width="480" height="100" />
      <text className="harness-diagram-kind" x="24" y="27">component tree</text>
      <text className="harness-diagram-value" x="24" y="58">system + compaction + tools + output</text>
      <text className="harness-diagram-detail" x="24" y="83">state = fold(events, step)</text>
    </g>

    <g className="harness-diagram-node harness-diagram-view" transform="translate(30 290)">
      <rect width="300" height="76" />
      <text className="harness-diagram-kind" x="24" y="27">views</text>
      <text className="harness-diagram-value" x="24" y="55">context + tools + output</text>
    </g>

    <g className="harness-diagram-node harness-diagram-transition" transform="translate(390 290)">
      <rect width="300" height="76" />
      <text className="harness-diagram-kind" x="24" y="27">transitions</text>
      <text className="harness-diagram-value" x="24" y="55">intents + effects</text>
    </g>

    <g className="harness-diagram-node harness-diagram-runtime" transform="translate(390 440)">
      <rect width="300" height="62" />
      <text className="harness-diagram-kind" x="24" y="24">runtime</text>
      <text className="harness-diagram-value" x="24" y="48">execute enabled work</text>
    </g>

    <g className="harness-diagram-connectors" aria-hidden="true">
      <path d="M360 82V126" />
      <path d="M360 226V260H180V290" />
      <path d="M360 226V260H540V290" />
      <path d="M540 366V440" />
      <path d="M690 471H708V46H510" />
    </g>

    <g className="harness-diagram-boundary" aria-hidden="true">
      <text x="30" y="390">pure</text>
      <path d="M30 399H690" />
      <text x="30" y="420">effectful</text>
    </g>

    <g className="harness-diagram-labels" aria-hidden="true">
      <text x="378" y="106">events</text>
      <text x="192" y="280">output</text>
      <text x="552" y="280">enabled work</text>
      <text x="561" y="426">execute</text>
      <text x="608" y="33">append events</text>
    </g>
  </svg>
)
