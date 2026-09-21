import { type ReactElement } from "react"

export const WorldEffectDiagram = (): ReactElement => (
  <figure className="component-overview" aria-label="Describing an effect is separate from executing its I/O">
    <svg viewBox="0 0 592 410" role="img" aria-label="Describe: a Tardigrade component produces an Effect value without performing I/O. Execute: the runtime runs that description and calls the model, producing a response and interacting with the world. World in and world out are a conceptual model of that interaction.">
      <g className="component-overview-globe">
        {[72, 520].map((x) => (
          <g key={x}>
            <circle className="globe-sphere" cx={x} cy="295" r="42" />
            <g className="globe-grid">
              <ellipse cx={x} cy="295" rx="16" ry="42" />
              <ellipse cx={x} cy="295" rx="31" ry="42" />
              <ellipse cx={x} cy="295" rx="42" ry="14" />
            </g>
          </g>
        ))}
      </g>
      <g className="component-overview-box">
        <rect x="24" y="48" width="170" height="86" />
        <text x="109" y="78">Tardigrade</text>
        <text x="109" y="105">component</text>
        <rect x="330" y="48" width="238" height="86" />
        <text x="449" y="78">Effect value</text>
        <rect x="191" y="255" width="210" height="80" />
        <text x="296" y="283">Runtime</text>
      </g>
      <g className="composition-links component-overview-links">
        <path d="M204 91H320m-8-5 8 5-8 5" />
        <path d="M449 144V158H296V245m-5-8 5 8 5-8" />
        <path d="M124 295H181m-8-5 8 5-8 5" />
        <path d="M411 295H468m-8-5 8 5-8 5" />
        <path d="M371 255V223H443m-8-5 8 5-8 5" />
      </g>
      <path d="M24 179H272M320 179H568" fill="none" stroke="var(--hair)" strokeDasharray="4 5" />
      <g className="component-overview-labels" textAnchor="middle">
        <text x="262" y="78">produces</text>
        <text x="449" y="107">description of a model call</text>
        <text x="296" y="312">calls the model</text>
        <text x="72" y="364">World in</text>
        <text x="520" y="364">World out</text>
        <text x="491" y="227">Response</text>
        <text x="309" y="203" textAnchor="start">run</text>
        <text x="24" y="27" textAnchor="start">1. Describe</text>
        <text x="24" y="148" textAnchor="start"><tspan x="24">Pure: build and compose</tspan><tspan x="24" dy="18">values. No I/O.</tspan></text>
        <text x="24" y="218" textAnchor="start">2. Execute</text>
        <text x="296" y="398">Running the description performs I/O.</text>
      </g>
    </svg>
  </figure>
)
