import { Bird } from "@phosphor-icons/react"
import { useId, type ReactElement } from "react"
import { PostalStamp } from "../../PostalStamp"

// CaveStamp crops CaveDiagram to the shadow on the wall: the bird's silhouette in the patch of light.
export const CaveStamp = (): ReactElement => {
  const perforation = useId()
  const window = useId()
  const edge = useId()
  return (
    <svg className="note-stamp" viewBox="-6 -4 96 108" aria-hidden="true">
      <defs>
        {/* edge traces the perforated outline of the paper in light blue. */}
        <filter id={edge} x="-10%" y="-10%" width="120%" height="120%">
          <feMorphology in="SourceAlpha" operator="dilate" radius="1" result="grown" />
          <feFlood className="note-stamp-edge" />
          <feComposite in2="grown" operator="in" />
          <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <g transform="rotate(4 42 50)">
      <g filter={`url(#${edge})`}><PostalStamp className="note-stamp-paper" id={perforation} x={2} y={2} width={80} height={96} /></g>
      <defs><clipPath id={window}><rect x="11" y="11" width="62" height="78" /></clipPath></defs>
      <g clipPath={`url(#${window})`}>
        <rect className="note-stamp-rock" x="11" y="11" width="62" height="78" />
        <ellipse className="note-stamp-light" cx="42" cy="48" rx="15" ry="30" />
        <Bird className="note-stamp-bird" x="30" y="36" size={24} weight="fill" />
      </g>
      </g>
    </svg>
  )
}
