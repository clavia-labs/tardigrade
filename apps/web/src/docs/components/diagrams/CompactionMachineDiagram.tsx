import type { ReactElement } from "react"

export const CompactionMachineDiagram = (): ReactElement => (
  <svg
    className="compaction-machine-diagram"
    viewBox="0 0 720 535"
    role="img"
    aria-label="Events advance the compaction state machine. Its output supplies a bounded context policy and may enable a compaction effect. The effect records CompactionCompleted, which advances the machine to a new checkpoint and retained transcript."
  >
    <defs>
      <marker id="compaction-machine-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0 0L8 4L0 8Z" />
      </marker>
    </defs>

    <g className="compaction-machine-node" transform="translate(230 10)">
      <rect width="260" height="64" />
      <text className="compaction-machine-kind" x="22" y="24">event input</text>
      <text className="compaction-machine-value" x="22" y="49">eₙ</text>
    </g>

    <g className="compaction-machine-state" transform="translate(125 115)">
      <rect width="470" height="105" />
      <text className="compaction-machine-kind" x="24" y="27">compaction state</text>
      <text className="compaction-machine-value" x="24" y="58">checkpoint + retained transcript</text>
      <text className="compaction-machine-detail" x="24" y="84">token count + round boundary</text>
      <text className="compaction-machine-code" x="446" y="91">step(state, event)</text>
    </g>

    <g className="compaction-machine-node compaction-machine-view" transform="translate(30 285)">
      <rect width="290" height="76" />
      <text className="compaction-machine-kind" x="22" y="27">view</text>
      <text className="compaction-machine-value" x="22" y="55">bounded context policy</text>
    </g>

    <g className="compaction-machine-node compaction-machine-transition" transform="translate(400 285)">
      <rect width="290" height="76" />
      <text className="compaction-machine-kind" x="22" y="27">transition</text>
      <text className="compaction-machine-value" x="22" y="55">summarize older span</text>
    </g>

    <g className="compaction-machine-node compaction-machine-inference" transform="translate(30 440)">
      <rect width="290" height="76" />
      <text className="compaction-machine-kind" x="22" y="27">inference transcript</text>
      <text className="compaction-machine-value" x="22" y="55">summary + retained tail</text>
    </g>

    <g className="compaction-machine-node compaction-machine-event" transform="translate(400 440)">
      <rect width="290" height="76" />
      <text className="compaction-machine-kind" x="22" y="27">event appended</text>
      <text className="compaction-machine-value" x="22" y="55">CompactionCompleted</text>
    </g>

    <g className="compaction-machine-connectors" aria-hidden="true">
      <path d="M360 74V115" />
      <path d="M360 220V255H175V285" />
      <path d="M360 220V255H545V285" />
      <path d="M175 361V440" />
      <path d="M545 361V440" />
      <path d="M690 478H708V42H490" />
    </g>

    <g className="compaction-machine-labels" aria-hidden="true">
      <text x="380" y="98">step</text>
      <text x="378" y="248">output(state)</text>
      <text x="194" y="408">render</text>
      <text x="565" y="408">execute</text>
      <text x="590" y="30">next input</text>
    </g>
  </svg>
)
