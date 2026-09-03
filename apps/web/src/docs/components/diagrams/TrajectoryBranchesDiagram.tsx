import type { ReactElement } from "react"

const trajectoryPoints = [
  [194, 55], [410, 48], [684, 28],
  [206, 86], [434, 82], [694, 68],
  [226, 102], [456, 110], [682, 102],
  [258, 118], [500, 124], [692, 122],
  [224, 146], [438, 150], [680, 164],
  [208, 174], [430, 180], [694, 194],
  [264, 80], [520, 142], [690, 176],
  [274, 190], [582, 138], [700, 144]
] as const

export const TrajectoryBranchesDiagram = (): ReactElement => (
  <svg className="trajectory-branches-diagram" viewBox="0 0 720 208" role="img" aria-label="Possible agent trajectories" aria-describedby="trajectory-branches-description">
    <desc id="trajectory-branches-description">One current state branches into more possible trajectories as the operating horizon grows.</desc>
    <g className="trajectory-branches-paths">
      <path d="M32 112C96 92 116 44 194 55S322 29 410 48S548 20 684 28" />
      <path d="M32 112C102 99 130 78 206 86S340 69 434 82S568 52 694 68" />
      <path d="M32 112C112 108 152 116 226 102S358 91 456 110S590 90 682 102" />
      <path className="trajectory-branches-lead" d="M32 112C112 112 182 128 258 118S410 132 500 124S602 126 692 122" />
      <path d="M32 112C108 122 142 154 224 146S350 166 438 150S570 158 680 164" />
      <path d="M32 112C96 130 122 186 208 174S340 190 430 180S564 205 694 194" />
      <path d="M32 112C110 124 176 72 264 80S418 152 520 142S628 176 690 176" />
      <path d="M32 112C106 110 150 198 274 190S450 110 582 138S650 146 700 144" />
    </g>
    <g className="trajectory-branches-nodes">
      <rect className="trajectory-branches-origin" x="27.5" y="107.5" width="9" height="9" />
      {trajectoryPoints.map(([x, y], index) => (
        <rect key={`${x}-${y}`} x={x - (index % 3 === 2 ? 3.5 : 2.5)} y={y - (index % 3 === 2 ? 3.5 : 2.5)} width={index % 3 === 2 ? 7 : 5} height={index % 3 === 2 ? 7 : 5} />
      ))}
    </g>
    <g className="trajectory-branches-horizon" aria-hidden="true">
      <text x="24" y="12">NOW</text>
      <text x="696" y="12" textAnchor="end">LONGER HORIZON</text>
    </g>
  </svg>
)
