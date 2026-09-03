import type { ReactElement } from "react"

export const WorldGlobe = (): ReactElement => (
  <svg className="world-globe" viewBox="46 46 228 228" role="img" aria-label="The world" aria-describedby="world-globe-description">
    <desc id="world-globe-description">A globe representing the systems and people outside the actor.</desc>
    <defs>
      <clipPath id="world-globe-clip"><circle cx="160" cy="160" r="112" /></clipPath>
    </defs>
    <circle className="globe-sphere" cx="160" cy="160" r="112" />
    <g className="globe-grid" clipPath="url(#world-globe-clip)">
      <ellipse cx="160" cy="160" rx="28" ry="112" />
      <ellipse cx="160" cy="160" rx="54" ry="112" />
      <ellipse cx="160" cy="160" rx="80" ry="112" />
      <ellipse cx="160" cy="160" rx="100" ry="112" />
      <ellipse cx="160" cy="104" rx="91" ry="18" />
      <ellipse cx="160" cy="132" rx="107" ry="20" />
      <ellipse cx="160" cy="160" rx="112" ry="21" />
      <ellipse cx="160" cy="188" rx="107" ry="20" />
      <ellipse cx="160" cy="216" rx="91" ry="18" />
    </g>
  </svg>
)
