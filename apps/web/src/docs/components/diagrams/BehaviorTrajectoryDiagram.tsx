import type { ReactElement } from "react"

const points = [[28, 92], [132, 94], [246, 70], [370, 76], [492, 68], [636, 66], [692, 54]] as const

export const BehaviorTrajectoryDiagram = (): ReactElement => (
  <svg className="behavior-trajectory-diagram" viewBox="0 0 720 132" role="img" aria-labelledby="behavior-trajectory-title behavior-trajectory-description">
    <title id="behavior-trajectory-title">Behavior along one trajectory</title>
    <desc id="behavior-trajectory-description">A point on a single trajectory is highlighted as a function of all previous points.</desc>
    <path className="behavior-trajectory-path" d="M28 92C70 78 92 106 132 94C176 80 202 54 246 70C294 88 326 94 370 76C412 60 452 90 492 68C544 40 590 84 636 66C660 58 676 56 692 54" />
    <g className="behavior-trajectory-points">
      {points.map(([x, y], index) => <rect className={index === 4 ? "behavior-trajectory-current" : undefined} key={`${x}-${y}`} x={x - 3.5} y={y - 3.5} width="7" height="7" />)}
    </g>
    <g className="behavior-trajectory-annotation" aria-hidden="true">
      <text x="492" y="24">f(previous points)</text>
      <path d="M492 32V59M487 54l5 5 5-5" />
    </g>
  </svg>
)
