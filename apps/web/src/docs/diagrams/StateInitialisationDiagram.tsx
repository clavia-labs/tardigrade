import type { ReactElement } from "react"

export const StateInitialisationDiagram = (): ReactElement => (
  <figure className="state-initialisation" aria-label="Two old counter events become count 5, recorded as StateInitialised in a fresh event log">
    <div className="state-initialisation-flow">
      <section className="state-initialisation-history" aria-label="Source event log">
        <header><span>Old log</span><small>Source thread</small></header>
        <ol className="state-initialisation-events">
          <li><span className="state-initialisation-position">00</span><div><strong>Incremented</strong><code>delta: 2</code></div></li>
          <li><span className="state-initialisation-position">01</span><div><strong>Incremented</strong><code>delta: 3</code></div></li>
        </ol>
        <div className="state-initialisation-boundary">Settled boundary</div>
      </section>
      <div className="state-initialisation-conversion">
        <span>Your converter</span>
        <div className="state-initialisation-transfer"><svg viewBox="0 0 28 16" aria-hidden="true"><path d="M1 8h24m-5-5 5 5-5 5" /></svg><code>{"{ count: 5 }"}</code><svg viewBox="0 0 28 16" aria-hidden="true"><path d="M1 8h24m-5-5 5 5-5 5" /></svg></div>
        <small>Serialised state</small>
      </div>
      <section className="state-initialisation-destination" aria-label="Destination event log">
        <header><span>New log</span><small>Fresh thread</small></header>
        <ol className="state-initialisation-events">
          <li><span className="state-initialisation-position">00</span><div><strong>ThreadCreated</strong></div></li>
          <li className="state-initialisation-seed"><span className="state-initialisation-position">01</span><div><strong>StateInitialised</strong><span className="state-initialisation-atom">example.counter</span><code>{"{ count: 5 }"}</code></div></li>
          <li><span className="state-initialisation-position">02</span><div><strong>Added</strong><code>amount: 2</code></div></li>
        </ol>
        <div className="state-initialisation-continuation">New events continue</div>
      </section>
    </div>
    <figcaption>The new log starts with the state extracted from the old one.</figcaption>
  </figure>
)
