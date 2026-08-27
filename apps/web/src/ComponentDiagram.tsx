import type { ReactElement } from "react"

export const ComponentDiagram = (): ReactElement => (
  <svg
    className="component-diagram"
    viewBox="0 0 720 680"
    role="img"
    aria-label="A 104,000-token event log enables the compaction component to derive a summarization effect. The effect appends a CompactionCompleted event. Later model requests use its summary and a retained 64,000-token tail."
  >
    <defs>
      <marker id="component-diagram-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0 0L8 4L0 8Z" />
      </marker>
    </defs>

    <g className="component-diagram-node" transform="translate(210 20)">
      <rect width="300" height="86" />
      <text className="component-diagram-kind" x="18" y="23">event log</text>
      <text className="component-diagram-value" x="18" y="51">104k tokens</text>
      <text className="component-diagram-detail" x="18" y="72">compaction threshold crossed</text>
    </g>

    <g className="component-diagram-component" transform="translate(160 158)">
      <rect width="400" height="106" />
      <text className="component-diagram-kind" x="20" y="25">component · compaction</text>
      <text className="component-diagram-function" x="20" y="59">derive(log)</text>
      <text className="component-diagram-detail" x="20" y="86">pure · observes the log</text>
    </g>

    <g className="component-diagram-node component-diagram-transition" transform="translate(210 318)">
      <rect width="300" height="86" />
      <text className="component-diagram-kind" x="18" y="23">effect transition</text>
      <text className="component-diagram-value" x="18" y="51">summarize old span</text>
      <text className="component-diagram-detail" x="18" y="72">runtime executes</text>
    </g>

    <g className="component-diagram-node" transform="translate(210 458)">
      <rect width="300" height="86" />
      <text className="component-diagram-kind" x="18" y="23">event · appended to log</text>
      <text className="component-diagram-value" x="18" y="51">CompactionCompleted</text>
      <text className="component-diagram-detail" x="18" y="72">summary and checkpoint recorded</text>
    </g>

    <g className="component-diagram-node component-diagram-view" transform="translate(180 598)">
      <rect width="360" height="62" />
      <text className="component-diagram-kind" x="18" y="22">next model context</text>
      <text className="component-diagram-value" x="18" y="47">summary + 64k-token tail</text>
    </g>

    <g className="component-diagram-connectors" aria-hidden="true">
      <path d="M360 106V158" />
      <path d="M360 264V318" />
      <path d="M360 404V458" />
      <path d="M360 544V598" />
    </g>
  </svg>
)
