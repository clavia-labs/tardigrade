import { useState, type ReactElement } from "react"

const events = [
  { name: "ToolCalled", detail: "Look up the weather" },
  { name: "PermissionGranted", detail: "Allow this tool call" },
  { name: "ToolReturned", detail: "Sunny, 24°C" },
  { name: "TurnCompleted", detail: "Answer delivered" }
]

export const StateSnapshotDiagram = (): ReactElement => {
  const [historyVisible, setHistoryVisible] = useState(true)
  return (
    <figure className="state-snapshot" aria-label="Event history and a snapshot of component state">
      <div className="state-snapshot-comparison">
        <section className="state-snapshot-history" aria-label="Event history">
          <span className="ship-projection-label">How we got here</span>
          <div className="state-snapshot-stack">
            <ol aria-hidden={!historyVisible} data-active={historyVisible}>{events.map(event => <li key={event.name}><strong>{event.name}</strong><span>{event.detail}</span></li>)}</ol>
            <div className="state-snapshot-missing" aria-hidden={historyVisible} data-active={!historyVisible}><span aria-hidden="true">?</span><p>Which tool ran?<br />What did it return?<br />Was permission granted?</p><small>The snapshot alone does not tell us.</small></div>
          </div>
        </section>
        <div className="state-snapshot-arrow" aria-hidden="true"><span>snapshot</span><svg viewBox="0 0 100 24"><path d="M2 12h94m-8-7 8 7-8 7" /></svg></div>
        <section className="state-snapshot-current" aria-label="Saved component state">
          <span className="ship-projection-label">Where we are now</span>
          <dl><div><dt>Inference</dt><dd>Done</dd></div><div><dt>Budget</dt><dd>Available</dd></div><div><dt>Permission</dt><dd>Not requested</dd></div></dl>
          <p>Enough to restore these states.<br />Their history is absent.</p>
        </section>
      </div>
      <div className="composition-actions"><button type="button" className="state-snapshot-toggle" aria-pressed={!historyVisible} onClick={() => setHistoryVisible(!historyVisible)}><span data-active={historyVisible}>Keep only the snapshot</span><span data-active={!historyVisible}>Show history again</span></button></div>
    </figure>
  )
}
