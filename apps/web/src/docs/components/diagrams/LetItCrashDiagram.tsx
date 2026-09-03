import type { ReactElement } from "react"

export const LetItCrashDiagram = (): ReactElement => (
  <svg
    className="let-it-crash-diagram"
    viewBox="0 0 200 200"
    role="img"
    aria-label="A continuous chain of stored events follows an S-shaped path."
  >
    <g className="let-it-crash-chain" aria-hidden="true">
      <path d="M35 35C104 16 165 34 165 72C165 98 137 102 100 102C61 102 35 119 35 143C35 174 93 174 165 165" />
    </g>
    <g className="let-it-crash-events">
      <rect x="27" y="27" width="16" height="16" />
      <rect x="88" y="23" width="16" height="16" />
      <rect x="157" y="64" width="16" height="16" />
      <rect x="92" y="94" width="16" height="16" />
      <rect x="27" y="135" width="16" height="16" />
      <rect className="let-it-crash-event-resumed" x="84" y="159" width="16" height="16" />
      <rect x="157" y="157" width="16" height="16" />
    </g>
  </svg>
)
