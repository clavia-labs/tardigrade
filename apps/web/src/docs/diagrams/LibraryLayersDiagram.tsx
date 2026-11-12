import { useId, type ReactElement } from "react"

export const LibraryLayersDiagram = (): ReactElement => {
  const arrow = useId()
  return <figure className="agent-services-diagram">
    <svg viewBox="0 0 760 252" role="img" aria-label="An agent selects the workspace library, whose methods require the Workspace service. The host supplies either a virtual workspace using SQLite and just-bash, or a Boxd workspace using a container.">
      <defs><marker id={arrow} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="m1 1 4 4-4 4" /></marker></defs>
      <g className="agent-services-links" markerEnd={`url(#${arrow})`}>
        <path d="M178 126H254" />
        <path d="M510 57H484Q470 57 470 71V112Q470 126 456 126H436" />
        <path d="M510 195H484Q470 195 470 181V140Q470 126 456 126H436" />
      </g>
      <g className="agent-services-node">
        <rect x="8" y="87" width="170" height="78" rx="8" />
        <text x="93" y="117">Agent</text>
        <text className="agent-services-code" x="93" y="142">tools: [workspace]</text>
        <rect x="264" y="87" width="164" height="78" rx="8" />
        <text x="346" y="117">Workspace</text>
        <text className="agent-services-detail" x="346" y="142">Effect service</text>
        <rect x="520" y="16" width="232" height="82" rx="8" />
        <text x="636" y="47">Virtual workspace</text>
        <text className="agent-services-detail" x="636" y="73">SQLite + just-bash</text>
        <rect x="520" y="154" width="232" height="82" rx="8" />
        <text x="636" y="185">Boxd workspace</text>
        <text className="agent-services-detail" x="636" y="211">Container + native binaries</text>
      </g>
    </svg>
    <figcaption>The library exposes the service. The host supplies its implementation.</figcaption>
  </figure>
}
