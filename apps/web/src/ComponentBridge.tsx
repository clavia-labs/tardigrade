import type { ReactElement } from "react"
import { PostalStamp } from "./PostalStamp"

export const ComponentBridge = (): ReactElement => (
  <svg className="component-bridge" viewBox="0 0 320 320" role="img" aria-labelledby="component-bridge-title component-bridge-description">
    <title id="component-bridge-title">Component</title>
    <desc id="component-bridge-description">The component derives work from log events, interacts with the world, and returns new events to the log.</desc>
    <defs>
      <marker id="component-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0 0L8 4L0 8Z" />
      </marker>
    </defs>
    <PostalStamp className="bridge-stamp bridge-stamp-desktop" id="component-stamp" x={100} y={110} width={120} height={100} />
    <text className="bridge-stamp-label bridge-stamp-label-desktop" x="160" y="165">ƒ(log)</text>
    <PostalStamp className="bridge-stamp bridge-stamp-mobile" id="component-stamp-mobile" x={70} y={80} width={180} height={150} />
    <text className="bridge-stamp-label bridge-stamp-label-mobile" x="160" y="164">ƒ(log)</text>
    <g className="bridge-paths bridge-paths-desktop">
      <path d="M0 160C26 150 56 170 82 160" />
      <path d="M238 160C264 150 294 170 320 160" />
    </g>
    <g className="bridge-labels bridge-labels-desktop">
      <text x="41" y="140">events</text>
      <text x="279" y="140">effects</text>
    </g>
    <g className="bridge-paths bridge-paths-mobile">
      <path d="M160 4C150 24 170 44 160 62" />
      <path d="M160 248C150 268 170 298 160 316" />
    </g>
    <g className="bridge-labels bridge-labels-mobile">
      <text x="188" y="48">events</text>
      <text x="188" y="282">effects</text>
    </g>
  </svg>
)
