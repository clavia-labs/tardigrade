import type { ReactElement } from "react"

export const ForkingDiagram = (): ReactElement => (
  <svg
    className="forking-diagram"
    viewBox="0 0 200 200"
    role="img"
    aria-label="A shared history forks from one checkpoint into several experimental trajectories."
  >
    <g className="forking-paths" aria-hidden="true">
      <path className="forking-path-main" d="M8 100H42" />
      <path d="M42 100C79 88 94 69 127 64C160 59 177 6 192 30" />
      <path d="M42 100C74 85 93 58 129 55C164 52 180 100 192 69" />
      <path d="M42 100C68 105 87 102 125 116C162 130 179 88 192 116" />
      <path d="M42 100C68 119 89 170 124 139C161 107 180 184 192 151" />
      <path className="forking-path-main" d="M42 100C68 106 93 107 122 145C155 189 179 145 192 180" />
    </g>
    <g className="forking-points">
      <rect className="forking-point-main" x="0" y="92" width="16" height="16" />
      <rect className="forking-point-origin" x="34" y="92" width="16" height="16" />
      <rect x="120" y="57" width="14" height="14" />
      <rect x="122" y="109" width="14" height="14" />
      <rect x="117" y="132" width="14" height="14" />
      <rect className="forking-point-main" x="115" y="138" width="14" height="14" />
      <rect x="185" y="23" width="14" height="14" />
      <rect x="185" y="62" width="14" height="14" />
      <rect x="185" y="109" width="14" height="14" />
      <rect x="185" y="144" width="14" height="14" />
      <rect className="forking-point-main" x="185" y="173" width="14" height="14" />
    </g>
  </svg>
)
