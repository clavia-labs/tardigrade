import type { ReactElement } from "react"

export const TardigradeAgentIllustration = ({ working, thinking, done }: { readonly working: boolean; readonly thinking: boolean; readonly done: boolean }): ReactElement => (
  <svg className="tool-agent-art" viewBox="35 50 245 210" role="img" aria-label={done ? "A tardigrade agent answering: done!" : thinking ? "A tardigrade agent calling the model" : "A tardigrade agent using a hammer"}>
    {(thinking || done) && <g className="tool-agent-bubble" transform="translate(28 30)" aria-hidden="true">
      <path d="M177 31h51a7 7 0 0 1 7 7v27a7 7 0 0 1-7 7h-31l-14 12 3-12h-9a7 7 0 0 1-7-7V38a7 7 0 0 1 7-7Z" />
      {done ? <text x="202" y="47"><tspan x="202" dy="7">done!</tspan></text> : <><circle cx="190" cy="52" r="2" /><circle cx="202" cy="52" r="2" /><circle cx="214" cy="52" r="2" /></>}
    </g>}
    <path className="tool-agent-ground" d="m30 229 128-32 115 38-129 29Z" />
    <ellipse className="tool-agent-shadow" cx="135" cy="218" rx="83" ry="9" />
    <g transform="translate(0 32.55) scale(1 .85)">
    <path className="tool-agent-body" d="M44 178c-2-21 13-37 32-38 10-13 26-16 41-11 13-10 29-11 43-6 14-8 29-5 38 6 9 11 10 27 0 38-5 6-11 10-16 16-10 16-25 21-42 19-12 10-28 12-43 6-16 6-34 1-44-12-6-5-9-11-10-18Z" />
    <path className="tool-agent-shade" d="M48 182q26 22 54 12 28 7 47-9 22-1 32-15 14-7 23-18 0 10-7 15-8 8-14 16-16 23-42 19-21 16-43 6-29 9-44-12Z" />
    <g className="tardigrade-segments">
      <path d="M76 140q-8 15-3 29M117 129q-9 17-4 34M160 123q-10 17-7 30" />
    </g>
    <g className="tool-agent-detail">
      <path d="M54 164q3-10 12-15m19-5 9-4m29-6 10-3m36 1q7-4 14 0" />
    </g>
    <g className="tardigrade-skin">
      <path d="m57 179 3 1m7 9 3 1m15-12 3 1m6-22 2 1m6 30 3 1m21-12 2 1m9 13 3-1m-4-43 3 1m25 18 3 1m-7 17 3-1" />
    </g>
    <g transform="translate(160 177) scale(.84) translate(-160 -177)">
    <ellipse className="tool-agent-eye" cx="192" cy="140" rx="3" ry="4" />
    <circle className="tool-agent-eye-glint" cx="193" cy="139" r=".9" />
    <g transform="translate(202 0) scale(.78 1) translate(-202 0)">
    <path className="tardigrade-muzzle" d="M205 152q9-4 15 1 3 2 2 6l-1 5q-1 4-5 5-7 2-13-2-2-1-1-4l2-8q0-2 1-3Z" />
    <ellipse className="tardigrade-mouth" cx="216" cy="160" rx="2.8" ry="4" transform="rotate(16 216 160)" />
    </g>
    </g>
    {[66, 95, 132].map((x) => (
      <g key={x} transform={x === 66 ? "translate(-10 -1) rotate(22 66 192)" : undefined}>
        <ellipse className="tardigrade-foot-contact" cx={x + 7} cy="218" rx="10" ry="2.5" />
        <path className="tool-agent-body" d={`M${x} 192q-4 9-1 17l-1 3q0 5 6 5h8q5-1 2-4l-5-4 5-12`} />
        <path className="tardigrade-claws" d={`M${x + 1} 216q-1 4 3 4m3-3q1 4 4 2m2-3q2 3 4 1`} />
        <path className="tool-agent-detail" d={`M${x + 1} 201q-1 4 1 6`} />
      </g>
    ))}
    </g>
    <g transform="translate(-20 10)">
    <g transform="translate(44 18)">
    <g className="tool-agent-hammer" data-working={working}>
      <path className="tool-agent-handle" d="M167.45 186 196 116 204 120 175.45 190Z" />
      <path className="tool-agent-hammer-top" d="m180 99 17-7 30 13-17 7Z" />
      <path className="tool-agent-hammer-side" d="m180 99 30 13-2 20-30-13Z" />
      <path className="tool-agent-hammer-front" d="m210 112 17-7-2 20-17 7Z" />
      <path className="tool-agent-detail" d="m182 105 21 9m-18-3 16 7m-26 62 4-10" />
      {working && <g className="tool-agent-sparks"><path d="m207 84 1-7m16 13 5-6m3 19 8-1" /></g>}
    </g>
    </g>
    <path className="tool-agent-wing" d="M180 171c-3-14 9-23 18-15 7 6 5 16-1 22q-3 8 3 10l16-1q5 3 1 7l-8 4c-15 4-29 1-34-10-3-8-1-13 5-17Z" />
    <path className="tool-agent-detail" d="M185 166q5-7 11-2m-13 10q7 4 13-2M181 184q5 9 18 9m7-1 6-2" />
    </g>
  </svg>
)
