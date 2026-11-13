import { useId, type ReactElement } from "react"

export const AgentServicesDiagram = (): ReactElement => {
  const arrow = useId()
  return <div className="agent-services-diagram">
    <svg viewBox="0 0 760 346" role="img" aria-label="The Meeseeks actor requires model configuration through modelInfo, inference through modelActs, and workspace tools through its declared library. The model lock supplies configuration, the provider supplies inference, and a local or remote workspace supplies tools.">
      <defs><marker id={arrow} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="m1 1 4 4-4 4" /></marker></defs>
      <g className="agent-services-links" markerEnd={`url(#${arrow})`}>
        <path d="M214 161H270Q284 161 284 147V58Q284 44 298 44H354" />
        <path d="M214 161H354" />
        <path d="M214 161H270Q284 161 284 175V264Q284 278 298 278H354" />
      </g>
      <g className="agent-services-node">
        <rect x="24" y="121" width="190" height="80" rx="8" />
        <text x="119" y="155">meeseeks</text>
        <text className="agent-services-detail" x="119" y="180">Agent actor</text>
      </g>
      {[
        { y: 6, title: "Model configuration", code: "modelInfo", source: "Model lock" },
        { y: 123, title: "Model inference", code: "modelActs", source: "Provider + credentials" },
        { y: 240, title: "Workspace tools", code: "tools: [workspace]", source: "localWorkspace / remoteWorkspace" },
      ].map(node => <g className="agent-services-node" key={node.code}>
        <rect x="364" y={node.y} width="372" height="76" rx="8" />
        <text x="550" y={node.y + 29}>{node.title}</text>
        <text className="agent-services-code" x="550" y={node.y + 53}>{node.code}</text>
        <text className="agent-services-detail" x="550" y={node.y + 96}>{node.source}</text>
      </g>)}
    </svg>
  </div>
}
