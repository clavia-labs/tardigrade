import { useId, type ReactElement } from "react"

export const LibraryContextDiagram = (): ReactElement => {
  const arrow = useId()
  return <figure className="library-context-diagram">
    <svg viewBox="0 0 840 436" role="img" aria-label="The Workspace library supplies instructions appended to the system prompt and a current file tree appended to the user message. Previous conversation messages remain between them.">
      <defs>
        <marker id={arrow} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="m2 1 4 4-4 4" />
        </marker>
      </defs>

      <text className="context-heading" x="358" y="84" textAnchor="middle">Prompt chunks</text>
      <text className="context-heading" x="670" y="28" textAnchor="middle">Model context</text>
      <rect className="context-frame" x="514" y="46" width="312" height="376" rx="12" />

      <g className="context-links" markerEnd={`url(#${arrow})`}>
        <path d="M206 224H238Q254 224 254 208V168Q254 152 270 152H288" />
        <path d="M206 274H238Q254 274 254 290V366Q254 382 270 382H288" />
        <path d="M438 152H528" />
        <path d="M438 382H528" />
      </g>

      <rect className="context-library" x="14" y="190" width="192" height="112" rx="10" />
      <text className="context-library-title" x="110" y="239" textAnchor="middle">Workspace</text>
      <text className="context-code" x="110" y="267" textAnchor="middle">Library.context</text>

      <rect className="context-chunk" x="292" y="124" width="146" height="56" rx="7" />
      <text className="context-slot" x="307" y="146">system</text>
      <text className="context-detail" x="307" y="165">How to use tools</text>

      <rect className="context-chunk" x="292" y="344" width="146" height="76" rx="7" />
      <text className="context-slot" x="307" y="366">user</text>
      <text className="context-file" x="307" y="388">src/</text>
      <path className="context-tree" d="M312 395v10h9" />
      <text className="context-file" x="327" y="409">agent.ts</text>

      <text className="context-label" x="534" y="73">SYSTEM</text>
      <rect className="context-base" x="534" y="84" width="272" height="40" rx="6" />
      <text className="context-body" x="550" y="109">Actor instructions</text>
      <rect className="context-chunk" x="534" y="132" width="272" height="40" rx="6" />
      <text className="context-body" x="550" y="157">Workspace instructions</text>

      <text className="context-label" x="534" y="209">HISTORY</text>
      <rect className="context-history" x="534" y="220" width="272" height="54" rx="6" />
      <text className="context-detail" x="550" y="247" dominantBaseline="middle">Previous messages</text>

      <text className="context-label" x="534" y="309">CURRENT USER</text>
      <rect className="context-base" x="534" y="320" width="272" height="32" rx="6" />
      <text className="context-body" x="550" y="342">User message</text>
      <rect className="context-chunk" x="534" y="360" width="272" height="44" rx="6" />
      <text className="context-body" x="550" y="387">Current file tree</text>
    </svg>
  </figure>
}
