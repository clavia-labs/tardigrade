import type { ReactElement } from "react"

export const RlmDiagram = (): ReactElement => (
  <div className="rlm-diagram" role="img" aria-label="A long context enters a code environment that makes recursive model calls and returns a final answer">
    <div className="rlm-context-card"><span>context as data</span><div aria-hidden="true"><i /><i /><i /><i /><i /></div><code>context[0..n]</code></div>
    <div className="rlm-diagram-arrow" aria-hidden="true" />
    <div className="rlm-program-card"><span>code environment</span><code>inspect(context)</code><code>partition(context)</code><strong>recursive model calls</strong><div className="rlm-subcalls" aria-hidden="true"><i>LM 01</i><i>LM 02</i><i>LM 03</i></div></div>
    <div className="rlm-diagram-arrow" aria-hidden="true" />
    <div className="rlm-answer-card"><span>result</span><strong>final answer</strong></div>
  </div>
)
