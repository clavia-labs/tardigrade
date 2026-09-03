import type { ReactElement } from "react"

export const PrimitiveDiagram = (): ReactElement => (
  <svg
    className="primitive-diagram"
    viewBox="0 0 720 690"
    role="img"
    aria-label="Events are inputs to projection machines. Components are projections whose output contains a view and transitions. Transitions are intents or effects."
  >
    <defs>
      <marker id="primitive-diagram-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0 0L8 4L0 8Z" />
      </marker>
    </defs>

    <g className="primitive-diagram-node" transform="translate(230 20)">
      <rect width="260" height="82" />
      <text className="primitive-diagram-kind" x="24" y="30">event</text>
      <text className="primitive-diagram-value" x="24" y="62">immutable fact</text>
    </g>

    <g className="primitive-diagram-node primitive-diagram-projection" transform="translate(150 164)">
      <rect width="420" height="106" />
      <text className="primitive-diagram-kind" x="24" y="30">projection</text>
      <text className="primitive-diagram-value" x="24" y="64">Machine&lt;Event, State, Value&gt;</text>
      <text className="primitive-diagram-detail" x="24" y="88">initial · step · output</text>
    </g>

    <g className="primitive-diagram-node primitive-diagram-component" transform="translate(150 334)">
      <rect width="420" height="106" />
      <text className="primitive-diagram-kind" x="24" y="30">component</text>
      <text className="primitive-diagram-value" x="24" y="64">Projection&lt;State, ComponentOutput&gt;</text>
      <text className="primitive-diagram-detail" x="24" y="88">named · composable</text>
    </g>

    <g className="primitive-diagram-node primitive-diagram-view" transform="translate(35 574)">
      <rect width="280" height="92" />
      <text className="primitive-diagram-kind" x="24" y="30">view</text>
      <text className="primitive-diagram-value" x="24" y="64">value for its parent</text>
    </g>

    <g className="primitive-diagram-node primitive-diagram-transition" transform="translate(405 574)">
      <rect width="280" height="92" />
      <text className="primitive-diagram-kind" x="24" y="30">transitions</text>
      <text className="primitive-diagram-value" x="24" y="64">intents + effects</text>
    </g>

    <g className="primitive-diagram-connectors" aria-hidden="true">
      <path d="M360 102V164" />
      <path d="M360 270V334" />
      <path d="M360 440V508H175V574" />
      <path d="M360 440V508H545V574" />
    </g>

    <g className="primitive-diagram-labels" aria-hidden="true">
      <text x="378" y="137">input</text>
      <text x="378" y="306">specializes</text>
      <text x="187" y="538">view</text>
      <text x="557" y="538">enabled work</text>
    </g>
  </svg>
)
