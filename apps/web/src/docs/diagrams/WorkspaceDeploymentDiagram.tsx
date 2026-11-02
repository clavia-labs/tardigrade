import { useId, type ReactElement } from "react"

export const WorkspaceDeploymentDiagram = ({ platform = "cloudflare" }: { readonly platform?: "bun" | "cloudflare" }): ReactElement => {
  const local = platform === "bun"
  const arrow = useId()
  return <div className="agent-services-diagram workspace-deployment-diagram">
    <svg viewBox="0 0 780 334" role="img" aria-label={local ? "Workspace tools require FilesystemWorkspace. On Bun, virtualWorkspace supplies just-bash and SQLite files, or localWorkspace supplies Bun.spawn and the host filesystem." : "Workspace tools use remoteWorkspace to call one of two Durable Object implementations. The virtual workspace runs just-bash over SQLite files. The container workspace runs bash and Python with container files or an R2 mount."}>
      <defs><marker id={arrow} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="m1 1 4 4-4 4" /></marker></defs>
      <g className="agent-services-links" markerEnd={`url(#${arrow})`}>
        <path d="M166 167H206" />
        <path d="M406 167H440Q454 167 454 153V79Q454 65 468 65H484" />
        <path d="M406 167H440Q454 167 454 181V255Q454 269 468 269H484" />
      </g>
      <g className="agent-services-node">
        <rect x="12" y="131" width="154" height="72" rx="8" />
        <text className="agent-services-code" x="89" y="161">workspaceTools</text>
        <text className="agent-services-detail" x="89" y="185">bash, read, write, edit</text>
        <rect x="216" y="131" width="190" height="72" rx="8" />
        <text className="agent-services-code" x="311" y="161">{local ? "FilesystemWorkspace" : "remoteWorkspace"}</text>
        <text className="agent-services-detail" x="311" y="185">{local ? "Workspace service" : "Durable Object RPC"}</text>
        <rect x="494" y="12" width="270" height="106" rx="8" />
        <text x="629" y="42">Virtual workspace</text>
        <text className="agent-services-code" x="629" y="69">just-bash</text>
        <text className="agent-services-detail" x="629" y="94">Files in SQLite</text>
        <rect x="494" y="216" width="270" height="106" rx="8" />
        <text x="629" y="246">{local ? "Local workspace" : "Container workspace"}</text>
        <text className="agent-services-code" x="629" y="273">{local ? "Bun.spawn" : "bash + python3"}</text>
        <text className="agent-services-detail" x="629" y="298">{local ? "Host filesystem" : "Container files / R2 mount"}</text>
      </g>
    </svg>
  </div>
}
