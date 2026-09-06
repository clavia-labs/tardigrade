import { type ReactElement } from "react"

const elevation = 30 * Math.PI / 180
const yaw = 15 * Math.PI / 180
const screenRecline = 12 * Math.PI / 180
const laptopWidth = 140
const laptopDepth = 90
const widthX = Math.cos(yaw)
const widthY = Math.sin(elevation) * Math.sin(yaw)
const depthX = -Math.sin(yaw)
const depthY = Math.sin(elevation) * Math.cos(yaw)
const screenX = depthX * Math.sin(screenRecline)
const screenY = depthY * Math.sin(screenRecline) + Math.cos(elevation) * Math.cos(screenRecline)
const hingeX = 100 - laptopWidth * widthX / 2
const hingeY = 190 - laptopWidth * widthY / 2
const baseThickness = 4
const basePoint = (x: number, y: number, drop = 0): string =>
  `${hingeX + x * widthX + y * depthX},${hingeY + x * widthY + y * depthY + drop}`

export const ThreadResolutionDiagram = (): ReactElement => (
  <svg className="thread-resolution-illustration" viewBox="0 0 400 390" role="img" aria-label="On the left, rickRef branches right to two alternative placements: an edge server above and a local laptop below. Each shows Rick's main thread inside its process.">
    <text className="resolution-ref" x="60" y="180">rickRef</text>
    <text className="resolution-caption" x="60" y="202">host resolves</text>
    <g className="resolution-routes" aria-hidden="true">
      <path d="M108 185H134C174 185 161 86 215 86" />
      <path d="M134 185C174 185 161 273 209 273" />
      <circle cx="215" cy="86" r="3" />
      <circle cx="209" cy="273" r="3" />
    </g>
    <text className="resolution-caption" x="297" y="188">or</text>
    <g transform="translate(210 100)">
      <g aria-hidden="true">
        <polygon className="resolution-device" points={[
          basePoint(laptopWidth, 0), basePoint(laptopWidth, laptopDepth),
          basePoint(laptopWidth, laptopDepth, baseThickness), basePoint(laptopWidth, 0, baseThickness),
        ].join(" ")} />
        <polygon className="resolution-device" points={[
          basePoint(0, laptopDepth), basePoint(laptopWidth, laptopDepth),
          basePoint(laptopWidth, laptopDepth, baseThickness), basePoint(0, laptopDepth, baseThickness),
        ].join(" ")} />
      </g>
      <g transform={`matrix(${widthX} ${widthY} ${depthX} ${depthY} ${hingeX} ${hingeY})`} aria-hidden="true">
        <rect className="resolution-device" width={laptopWidth} height={laptopDepth} />
        <rect className="resolution-screen" x="10" y="10" width="120" height="42" rx="2" />
        <path className="resolution-detail" d="M10 24H130M10 38H130M30 10V52M50 10V52M70 10V52M90 10V52M110 10V52" />
        <rect className="resolution-screen" x="49" y="61" width="42" height="21" rx="2" />
      </g>
      <g transform={`matrix(${widthX} ${widthY} ${screenX} ${screenY} ${hingeX - laptopDepth * screenX} ${hingeY - laptopDepth * screenY})`}>
        <rect className="resolution-device" width={laptopWidth} height={laptopDepth} rx="5" />
        <rect className="resolution-screen" x="6" y="6" width="128" height="78" rx="2" />
        <text className="resolution-caption" x="70" y="27">Local process</text>
        <rect className="resolution-thread" x="11" y="38" width="118" height="33" rx="4" />
        <text x="70" y="60">rick / main</text>
      </g>
      <text x="100" y="270">Local computer</text>
    </g>
    <g transform="translate(-10 -94)">
      <g aria-hidden="true">
      <path className="resolution-device" d="M241 116L257 106H380V224L364 238H241Z" />
      <path className="resolution-detail" d="M241 116H364V238M364 116L380 106" />
      <rect className="resolution-screen" x="250" y="128" width="105" height="72" rx="3" />
      <path className="resolution-detail" d="M253 215H321M253 223H321" />
      <circle className="resolution-light" cx="346" cy="218" r="3" />
      </g>
    <text className="resolution-caption" x="303" y="149">Edge process</text>
    <rect className="resolution-thread" x="255" y="160" width="95" height="30" rx="5" />
    <text className="resolution-caption" x="303" y="180">rick / main</text>
      <text x="309" y="260">Edge server</text>
    </g>
  </svg>
)
