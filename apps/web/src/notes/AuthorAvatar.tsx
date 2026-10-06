import { useId, type ReactElement } from "react"
import arjun from "../../../../assets/authors/arjun-square-clear.svg"
import { PostalStamp } from "../PostalStamp"

// hatches are hand-drawn "/" strokes, each drawn from its lower-left end to its upper-right end, ordered from the top-left corner down to the bottom-right; a fixed wobble per stroke keeps renders stable.
const hatches = Array.from({ length: 20 }, (_, index) => {
  const sum = 18 + index * 7
  const x0 = Math.max(8, sum - 76)
  const x1 = Math.min(76, sum - 8)
  const wobble = ((index * 37) % 7) - 3
  const mx = (x0 + x1) / 2 + wobble * 0.7
  const my = sum - (x0 + x1) / 2 + wobble * 0.7
  return `M${x0 - 1} ${sum - x0 + 1}Q${mx} ${my} ${x1 + 1} ${sum - x1 - 1}`
})

// AuthorAvatar frames the author's portrait as a postage stamp; hovering the sign-off sketches its background darker.
export const AuthorAvatar = (): ReactElement => {
  const perforation = useId()
  const edge = useId()
  const window = useId()
  return (
    <svg className="notes-avatar" viewBox="-4 -4 92 92" aria-hidden="true">
      <defs>
        <filter id={edge} x="-10%" y="-10%" width="120%" height="120%">
          <feMorphology in="SourceAlpha" operator="dilate" radius="1" result="grown" />
          <feFlood className="note-stamp-edge" />
          <feComposite in2="grown" operator="in" />
          <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <clipPath id={window}><rect x="10" y="10" width="64" height="64" /></clipPath>
      </defs>
      <g transform="rotate(-4 42 42)">
        <g filter={`url(#${edge})`}><PostalStamp className="note-stamp-paper" id={perforation} x={2} y={2} width={80} height={80} /></g>
        <rect className="notes-avatar-ground" x="10" y="10" width="64" height="64" />
        <g className="notes-avatar-hatch" clipPath={`url(#${window})`}>
          {hatches.map((d, index) => <path key={d} d={d} pathLength={1} style={{ transitionDelay: `${index * 28}ms` }} />)}
        </g>
        <image href={arjun} x="10" y="10" width="64" height="64" />
      </g>
    </svg>
  )
}
