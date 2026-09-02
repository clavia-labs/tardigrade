import type { ReactElement } from "react"

export const CompactionMachineDiagram = (): ReactElement => (
  <svg
    className="compaction-machine-diagram"
    viewBox="0 0 720 670"
    role="img"
    aria-label="Events advance the compaction state machine. Its output supplies a bounded context policy and may enable a compaction effect. The effect records CompactionCompleted, which advances the machine to a new checkpoint and retained transcript."
  >
    <defs>
      <marker id="compaction-machine-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0 0L8 4L0 8Z" />
      </marker>
    </defs>

    <g className="compaction-machine-node" transform="translate(230 18)">
      <rect width="260" height="78" />
      <text className="compaction-machine-kind" x="22" y="28">event input</text>
      <text className="compaction-machine-value" x="22" y="57">eₙ</text>
    </g>

    <g className="compaction-machine-state" transform="translate(125 156)">
      <rect width="470" height="126" />
      <text className="compaction-machine-kind" x="24" y="30">compaction state</text>
      <text className="compaction-machine-value" x="24" y="65">checkpoint + retained transcript</text>
      <text className="compaction-machine-detail" x="24" y="94">token count + round boundary</text>
      <text className="compaction-machine-code" x="446" y="109">step(state, event)</text>
    </g>

    <g className="compaction-machine-node compaction-machine-view" transform="translate(30 368)">
      <rect width="290" height="88" />
      <text className="compaction-machine-kind" x="22" y="29">view</text>
      <text className="compaction-machine-value" x="22" y="61">bounded context policy</text>
    </g>

    <g className="compaction-machine-node compaction-machine-transition" transform="translate(400 368)">
      <rect width="290" height="88" />
      <text className="compaction-machine-kind" x="22" y="29">transition</text>
      <text className="compaction-machine-value" x="22" y="61">summarize older span</text>
    </g>

    <g className="compaction-machine-node compaction-machine-inference" transform="translate(30 558)">
      <rect width="290" height="88" />
      <text className="compaction-machine-kind" x="22" y="29">inference transcript</text>
      <text className="compaction-machine-value" x="22" y="61">summary + retained tail</text>
    </g>

    <g className="compaction-machine-node compaction-machine-event" transform="translate(400 558)">
      <rect width="290" height="88" />
      <text className="compaction-machine-kind" x="22" y="29">event appended</text>
      <text className="compaction-machine-value" x="22" y="61">CompactionCompleted</text>
    </g>

    <g className="compaction-machine-connectors" aria-hidden="true">
      <path d="M360 96V156" />
      <path d="M360 282V324H175V368" />
      <path d="M360 282V324H545V368" />
      <path d="M175 456V558" />
      <path d="M545 456V558" />
      <path d="M690 602H708V57H490" />
    </g>

    <g className="compaction-machine-labels" aria-hidden="true">
      <text x="380" y="130">step</text>
      <text x="378" y="315">output(state)</text>
      <text x="194" y="514">render</text>
      <text x="565" y="514">execute</text>
      <text x="590" y="45">next input</text>
    </g>
  </svg>
)
