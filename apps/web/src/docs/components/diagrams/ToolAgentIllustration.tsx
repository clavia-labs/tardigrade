import type { ReactElement } from "react"

export const ToolAgentIllustration = ({ working, thinking, done }: { readonly working: boolean; readonly thinking: boolean; readonly done: boolean }): ReactElement => (
  <svg className="tool-agent-art" viewBox="25 15 260 260" role="img" aria-label={done ? "A duck agent answering: quack quack!" : thinking ? "A duck agent calling the model, with a speech bubble" : working ? "A duck agent using a hammer" : "A duck agent holding a hammer"}>
    {(thinking || done) && <g className="tool-agent-bubble" aria-hidden="true">
      <path d="M177 31h51a7 7 0 0 1 7 7v27a7 7 0 0 1-7 7h-31l-14 12 3-12h-9a7 7 0 0 1-7-7V38a7 7 0 0 1 7-7Z" />
      {done ? <text x="202" y="47"><tspan x="202">quack</tspan><tspan x="202" dy="15">quack!</tspan></text> : <><circle cx="190" cy="52" r="2" /><circle cx="202" cy="52" r="2" /><circle cx="214" cy="52" r="2" /></>}
    </g>}
    <path className="tool-agent-ground" d="m35 230 91-35 100 42-92 34Z" />
    <ellipse className="tool-agent-shadow" cx="127" cy="236" rx="45" ry="10" transform="rotate(6 127 236)" />
    <g className="tool-agent-feet">
      <path d="m101 216-3 15-21 6 17 5 23-9-3-14M138 222l3 14-11 10 27-3 11-7-16-4-2-15" />
      <path className="tool-agent-detail" d="m94 237 12-5m35 7 13-3" />
    </g>
    <path className="tool-agent-body" d="M91 145C86 131 86 117 89 103c3-24 19-40 40-39 25-1 43 17 44 36 2 17-9 31-16 38l5 20c17 17 18 35 2 53-15 19-47 30-72 18-11-4-19-10-25-19-13-8-21-18-25-30l17 8c6-20 18-35 32-43Z" />
    <path className="tool-agent-shade" d="M63 198c17 20 41 26 65 20 17-4 30-13 43-29-1 8-4 15-10 22-16 19-45 27-69 18-11-4-19-10-25-19Z" />
    <path className="tool-agent-detail" d="M95 103q3-19 19-27m-15 31q2-16 11-25M54 194l11 10m-6-1 10 9M87 149l5 10" />
    <g className="tool-agent-feathers">
      <path d="m81 212 5 3m5 2 6 2m8 2 7 1m7-1 6-1m9-3 5-2m-62-9 4 2m48 7 5-2" />
    </g>
    <g transform="translate(128 155) scale(.87) translate(-128 -155)">
    <path className="tool-agent-beak" d="m163 109 33 9q7 2 2 5l-21 10-20-11Z" />
    <path className="tool-agent-beak-side" d="m157 122 20 11 22-11q-1 7-7 10l-16 8-18-9Z" />
    <path className="tool-agent-detail" d="m174 118 12 3" />
    <ellipse className="tool-agent-eye" cx="157" cy="95" rx="3.6" ry="5.2" transform="rotate(12 157 95)" />
    <ellipse className="tool-agent-eye-glint" cx="158" cy="93" rx="1" ry="1.4" />
    <path className="tool-agent-detail" d="M146 84q4-3 8-2" />
    </g>
    <g className="tool-agent-hammer" data-working={working}>
      <path className="tool-agent-handle" d="M167.45 186 196 116 204 120 175.45 190Z" />
      <path className="tool-agent-hammer-top" d="m180 99 17-7 30 13-17 7Z" />
      <path className="tool-agent-hammer-side" d="m180 99 30 13-2 20-30-13Z" />
      <path className="tool-agent-hammer-front" d="m210 112 17-7-2 20-17 7Z" />
      <path className="tool-agent-detail" d="m182 105 21 9m-18-3 16 7m-26 62 4-10" />
      {working && <g className="tool-agent-sparks"><path d="m207 84 1-7m16 13 5-6m3 19 8-1" /></g>}
    </g>
    <path className="tool-agent-wing" d="M113 153c-13 3-20 18-12 30 9 15 29 11 49 2l21-9q6-3 2-7l-4-4q-2-2-6-1l-21 5c-8-13-16-20-29-16Z" />
    <path className="tool-agent-detail" d="M108 171q8 13 27 9m-22 1q10 9 24 3m-28-27 9-1" />
  </svg>
)
