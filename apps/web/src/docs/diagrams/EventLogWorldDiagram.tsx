import type { ReactElement } from "react"
import { IsometricEventLog } from "../../site/artwork/IsometricEventLog"
import { WorldGlobe } from "../../site/artwork/WorldGlobe"

const events = [
  { name: "MessageReceived", value: "What is the meaning of life?" },
  { name: "ModelCalled", value: "Ask the calculator." },
  { name: "ToolCalled", value: "calculator(7 × 6)" },
  { name: "ToolReturned", value: "42" },
  { name: "ModelCalled", value: "Consider the answer." },
  { name: "ModelReturned", value: "The answer is 42." }
]

export const EventLogWorldDiagram = (): ReactElement => (
  <figure className="event-log-world" aria-label="An atom derives state and proposes effects from events. The runtime executes effects against the world and records results as events.">
    <div className="event-log-world-grid">
      <div className="event-log-boundary" aria-hidden="true"><span>Pure</span><span>Effectful</span></div>
      <div className="actor-log-panel"><IsometricEventLog entries={events} rectangular rowPadding={0} rowGap={4} appendingSequence="06" selectedSequence={null} derivedSequence={undefined} interactive={false} onSelect={() => {}} /><span className="diagram-column-label">Log</span></div>
      <div className="atom-chain-panel">
        <svg className="atom-chain" viewBox="0 0 380 320" role="img" aria-label="An atom derives state and proposes effects from an event and its current state.">
          <g className="atom-chain-arrows"><path d="M0 160H80M72 153L80 160L72 167M300 160H380M372 153L380 160L372 167" /></g>
          <g className="atom-chain-edge-labels"><text x="40" y="140">event</text><text x="340" y="140">effect</text></g>
          <g className="atom-chain-nodes"><rect x="86" y="122" width="208" height="76" /><text x="190" y="168">ƒ(event, state)</text></g>
          <g className="atom-chain-types"><text x="190" y="222">Atom</text></g>
        </svg>
      </div>
      <div className="world-panel"><WorldGlobe sketch /><span className="diagram-column-label">World</span></div>
    </div>
    <svg className="event-log-return" viewBox="0 0 720 72" role="img" aria-label="Results from the world are appended to the event log.">
      <path d="M644 -36V28Q644 40 632 40H154Q142 40 142 28V4m-5 7 5-7 5 7" />
      <rect x="330" y="28" width="60" height="24" />
      <text x="360" y="44" textAnchor="middle">event</text>
    </svg>
  </figure>
)
