import { useId, type ReactElement } from "react"

export const LibraryLayersDiagram = (): ReactElement => {
  const arrow = useId()
  return <figure className="agent-services-diagram">
    <svg viewBox="0 0 800 252" role="img" aria-label="An agent selects the workspace library, whose methods require the Workspace service. The host supplies either a virtual workspace using SQLite and just-bash, or a Cloudflare workspace using a container.">
      <defs><marker id={arrow} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="m1 1 4 4-4 4" /></marker></defs>
      <g className="agent-services-links" markerEnd={`url(#${arrow})`}>
        <path d="M218 126H294" />
        <path d="M550 57H524Q510 57 510 71V112Q510 126 496 126H476" />
        <path d="M550 195H524Q510 195 510 181V140Q510 126 496 126H476" />
      </g>
      <g className="agent-services-node">
        <rect x="8" y="87" width="210" height="78" rx="8" />
        <text x="113" y="117">Agent</text>
        <text className="agent-services-code" x="113" y="142">tools: [workspace]</text>
        <rect x="304" y="87" width="164" height="78" rx="8" />
        <text x="386" y="117">Workspace</text>
        <text className="agent-services-detail" x="386" y="142">Effect service</text>
        <rect x="560" y="16" width="232" height="82" rx="8" />
        <text x="676" y="47">Virtual workspace</text>
        <text className="agent-services-detail" x="676" y="73">SQLite + just-bash</text>
        <rect x="560" y="154" width="232" height="82" rx="8" />
        <text x="676" y="185">Cloudflare container</text>
        <text className="agent-services-detail" x="676" y="211">Container + native binaries</text>
      </g>
    </svg>
    <figcaption>The library exposes the service. The host supplies its implementation.</figcaption>
  </figure>
}
