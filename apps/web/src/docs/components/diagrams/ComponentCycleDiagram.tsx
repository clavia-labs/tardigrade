import { type ReactElement } from "react"

export const ComponentCycleDiagram = (): ReactElement => (
  <figure className="component-overview component-overview-loop" aria-label="The component cycle from event history to effects and back">
    <svg viewBox="0 0 760 490" role="img" aria-label="The event log feeds a component's pure projection to derive its state. Its output describes an Effect value. The runtime executes the Effect against the world and records the result in the event log, supplying the next input to the component.">
      <path d="M546 44V216M546 240V426" fill="none" stroke="var(--faint)" strokeDasharray="4 5" opacity="0.65" />
      <rect x="236" y="65" width="280" height="300" fill="none" stroke="var(--faint)" strokeDasharray="4 5" />
      <g className="component-overview-box">
        <rect x="14" y="101" width="130" height="210" />
        <text x="79" y="129">Event log</text>
        <rect x="258" y="123" width="236" height="64" />
        <text x="376" y="161">Derived state</text>
        <rect x="258" y="259" width="236" height="64" />
        <text x="376" y="286">Effect value</text>
        <rect x="579" y="196" width="158" height="64" />
        <text x="658" y="234">Runtime</text>
      </g>
      <g className="component-overview-globe">
        <circle className="globe-sphere" cx="658" cy="364" r="40" />
        <g className="globe-grid">
          <ellipse cx="658" cy="364" rx="15" ry="40" />
          <ellipse cx="658" cy="364" rx="29" ry="40" />
          <ellipse cx="658" cy="364" rx="40" ry="13" />
        </g>
      </g>
      <g className="composition-links component-overview-links">
        <path d="M154 155H248m-8-5 8 5-8 5" />
        <path d="M376 197V249m-5-8 5 8 5-8" />
        <path d="M504 291H530V228H569m-8-5 8 5-8 5" />
        <path d="M658 270V314m-5-8 5 8 5-8" />
        <path d="M658 414V448H79V321m-5 8 5-8 5 8" />
      </g>
      <g className="component-overview-labels" textAnchor="middle">
        <text x="534" y="28" textAnchor="end">Pure</text>
        <text x="558" y="28" textAnchor="start">Effectful</text>
        <text x="376" y="93">Component</text>
        <text x="79" y="165">event 1</text>
        <text x="79" y="197">event 2</text>
        <text x="79" y="229">…</text>
        <text x="79" y="270">new result</text>
        <text x="190" y="137">project</text>
        <text x="390" y="224" textAnchor="start">output</text>
        <text x="376" y="309">describe next action</text>
        <text x="376" y="346">same history, same state</text>
        <text x="658" y="181">execute description</text>
        <text x="675" y="296" textAnchor="start">I/O</text>
        <text x="710" y="369" textAnchor="start">World</text>
        <text x="376" y="474">record result as an event; repeat</text>
      </g>
    </svg>
  </figure>
)
