import type { ReactElement } from "react"

export const ComponentAnatomyDiagram = (): ReactElement => (
  <figure className="component-anatomy" aria-label="A component initializes state, updates it from events, and derives a view and enabled transitions">
    <div className="agent-projection-scroll">
      <svg viewBox="0 0 760 370" role="img" aria-label="initial creates state. step receives an event and the current state, then returns the next state. output reads state to produce a view and transitions, which can be intents or effects.">
        <rect className="agent-projection-boundary" x="166" y="8" width="574" height="348" />
        <g className="component-anatomy-labels"><text x="184" y="32">COMPONENT</text><text x="282" y="205">current state</text></g>
        <g className="composition-links">
          <path d="M132 128h49m-7-4 7 4-7 4M325 128h46m-7-4 7 4-7 4M515 128h46m-7-4 7 4-7 4M445 73v23m-4-7 4 7 4-7" />
          <path d="M405 159v60H255v-60m-4 7 4-7 4 7M635 159v78M525 237h145M525 237v26m-4-7 4 7 4-7M670 237v26m-4-7 4 7 4-7" />
        </g>
        <g className="component-anatomy-box"><rect x="20" y="101" width="112" height="54" /><text x="76" y="133">Event</text></g>
        <g className="component-anatomy-box"><rect x="185" y="101" width="140" height="54" /><text x="255" y="133">step(...)</text></g>
        <g className="component-anatomy-box component-anatomy-state"><rect x="375" y="101" width="140" height="54" /><text x="445" y="133">State</text></g>
        <g className="component-anatomy-box"><rect x="375" y="27" width="140" height="46" /><text x="445" y="55">initial()</text></g>
        <g className="component-anatomy-box"><rect x="565" y="101" width="140" height="54" /><text x="635" y="133">output(state)</text></g>
        <g className="component-anatomy-box component-anatomy-state"><rect x="461" y="267" width="128" height="65" /><text x="525" y="294">View</text><text className="component-anatomy-small" x="525" y="316">exposed state</text></g>
        <g className="component-anatomy-box component-anatomy-state"><rect x="608" y="267" width="120" height="65" /><text x="668" y="294">Transitions</text><text className="component-anatomy-small" x="668" y="316">intent / effect</text></g>
      </svg>
    </div>
  </figure>
)
