import { useId, type ReactElement } from "react"

export const PeopleTalkingDiagram = (): ReactElement => {
  const arrow = useId()
  return (
    <svg className="actor-communication-diagram people-talking-diagram" viewBox="0 0 560 268" role="img" aria-label="A dashed line connects Rick's head to a box containing his private portal code C-137. Morty asks, What's the portal code? Rick reveals it by replying, It's C-137, Morty.">
      <defs>
        <marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0L8 4L0 8Z" />
        </marker>
      </defs>
      <g className="actor-communication-links" aria-hidden="true">
        <path d="M160 176H280" markerStart={`url(#${arrow})`} markerEnd={`url(#${arrow})`} />
        <path d="M354 138H420" strokeDasharray="4 4" />
      </g>
      <text x="220" y="164">message</text>
      <path className="actor-communication-person" d="M78 24H198Q206 24 206 32V74Q206 82 198 82H126L106 102V82H78Q70 82 70 74V32Q70 24 78 24Z" />
      <path className="actor-communication-person" d="M242 24H362Q370 24 370 32V74Q370 82 362 82H334V102L314 82H242Q234 82 234 74V32Q234 24 242 24Z" />
      <text x="138" y="47">What's the</text>
      <text x="138" y="67">portal code?</text>
      <text x="302" y="47">It's C-137,</text>
      <text x="302" y="67">Morty.</text>
      {[{ x: 104, name: "Morty" }, { x: 336, name: "Rick" }].map(({ x, name }) => (
        <g key={name} transform={`translate(${x} 158)`}>
          <circle cy="-20" r="18" />
          <path className="actor-communication-person" d="M-32 62V36C-32 16-16 4 0 4S32 16 32 36V62Z" />
          <text y="88">{name}</text>
        </g>
      ))}
      <path className="actor-communication-person" d="M428 108H540Q548 108 548 116V160Q548 168 540 168H428Q420 168 420 160V116Q420 108 428 108Z" />
      <text x="484" y="132">Private</text>
      <text x="484" y="154">C-137</text>
    </svg>
  )
}
