import type { ReactElement } from "react"

export const TypedEffectDiagram = (): ReactElement => (
  <svg
    className="typed-effect-diagram"
    viewBox="0 0 200 200"
    role="img"
    aria-label="Three typed square layers compose into one stack."
  >
    <g className="typed-effect-layer typed-effect-layer-back">
      <rect x="66" y="18" width="116" height="116" />
      <circle cx="164" cy="36" r="4" />
    </g>
    <g className="typed-effect-layer typed-effect-layer-middle">
      <rect x="42" y="42" width="116" height="116" />
      <circle cx="140" cy="60" r="4" />
    </g>
    <g className="typed-effect-layer typed-effect-layer-active">
      <rect x="18" y="66" width="116" height="116" />
      <circle cx="116" cy="84" r="4" />
      <path className="typed-effect-check" d="M64 126L75 137L96 113" />
    </g>
  </svg>
)
