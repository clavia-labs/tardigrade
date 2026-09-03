import type { ReactElement } from "react"

const FlowArrow = ({ label }: { readonly label: string }): ReactElement => (
  <div className="compaction-flow-arrow" aria-hidden="true">
    <span>{label}</span>
    <svg viewBox="0 0 48 20">
      <path d="M1 10H43M38 5l5 5-5 5" />
    </svg>
  </div>
)

export const CompactionMachineDiagram = (): ReactElement => (
  <div
    className="compaction-machine-diagram"
    role="img"
    aria-label="The immutable event log contains a CompactionCompleted checkpoint. A projection converts its summary and the retained event tail into model messages, which are sent to inference. Inference appends new events to the log."
  >
    <section className="compaction-flow-stage">
      <span className="compaction-flow-kind">immutable event log</span>
      <div className="docs-event-log compaction-flow-event-log">
        <ol>
          <li><code>MessageReceived</code></li>
          <li><code>ToolCalled</code></li>
          <li><code>ToolReturned</code></li>
          <li><code>ToolCalled</code></li>
          <li><code>ToolReturned</code></li>
          <li><code>TextReturned</code></li>
          <li><code>MessageReceived</code></li>
          <li><code>ToolCalled</code></li>
          <li><code>ToolReturned</code></li>
          <li><code>CompactionCompleted</code><code>summary</code></li>
          <li><code>MessageReceived</code></li>
          <li><code>ToolCalled</code></li>
          <li><code>MessageReceived</code></li>
          <li><code>ToolCalled</code></li>
          <li><code>ToolReturned</code></li>
          <li><code>TextReturned</code></li>
        </ol>
      </div>
    </section>

    <FlowArrow label="project" />

    <section className="compaction-flow-stage compaction-flow-context">
      <span className="compaction-flow-kind">model context</span>
      <div className="compaction-flow-context-value">
        <code className="compaction-flow-context-type">ReadonlyArray&lt;AgentMessage&gt;</code>
        <div className="compaction-flow-context-section compaction-flow-context-summary">
          <span>summary from checkpoint</span>
          <div><code>user</code><p>Summary of earlier work…</p></div>
        </div>
        <div className="compaction-flow-context-section compaction-flow-context-tail">
          <span>projected conversation tail</span>
          <div><code>user</code><p>Retained message…</p></div>
          <div><code>assistant</code><p>tool call…</p></div>
          <div><code>tool</code><p>tool result…</p></div>
          <div><code>user</code><p>New message…</p></div>
          <div><code>assistant</code><p>tool call…</p></div>
        </div>
      </div>
    </section>

    <FlowArrow label="send" />

    <section className="compaction-flow-inference">
      <span className="compaction-flow-kind">inference</span>
    </section>

    <svg className="compaction-flow-return" viewBox="0 0 698 530" preserveAspectRatio="none" aria-hidden="true">
      <path d="M633 281V510H115V477" />
      <path d="m110 482 5-5 5 5" />
      <text x="374" y="503">append events</text>
    </svg>
  </div>
)
