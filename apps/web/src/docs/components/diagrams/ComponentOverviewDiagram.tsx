import { useId, type ReactElement } from "react"

export const ComponentOverviewDiagram = (): ReactElement => {
  const clip = useId()
  return (
    <figure className="component-overview" aria-label="A component takes events from the world and acts on it through effects">
      <svg viewBox="-72 0 592 240" role="img" aria-label="A component sits beside the world. Events flow from the world into the component. Effects flow from the component into the world. A loop on the component shows an event the component appends for itself.">
        <defs><clipPath id={clip}><circle cx="400" cy="120" r="90" /></clipPath></defs>
        <g className="component-overview-box"><rect x="30" y="80" width="180" height="80" /><text x="120" y="125">Component</text></g>
        <g className="component-overview-globe">
          <circle className="globe-sphere" cx="400" cy="120" r="90" />
          <g className="globe-grid" clipPath={`url(#${clip})`}>
            <ellipse cx="400" cy="120" rx="22" ry="90" />
            <ellipse cx="400" cy="120" rx="43" ry="90" />
            <ellipse cx="400" cy="120" rx="64" ry="90" />
            <ellipse cx="400" cy="120" rx="80" ry="90" />
            <ellipse cx="400" cy="75" rx="73" ry="14" />
            <ellipse cx="400" cy="98" rx="86" ry="16" />
            <ellipse cx="400" cy="120" rx="90" ry="17" />
            <ellipse cx="400" cy="142" rx="86" ry="16" />
            <ellipse cx="400" cy="165" rx="73" ry="14" />
          </g>
        </g>
        <g className="composition-links component-overview-links">
          <path d="M304 96H220m8-5-8 5 8 5" />
          <path d="M218 144h86m-8-5 8 5-8 5" />
          <path d="M30 100H-12V140H22m-8-5 8 5-8 5" />
        </g>
        <g className="component-overview-labels">
          <text x="262" y="86" textAnchor="middle">event</text>
          <text x="262" y="162" textAnchor="middle">effect</text>
          <text x="-20" y="124" textAnchor="end">event</text>
        </g>
      </svg>
    </figure>
  )
}
