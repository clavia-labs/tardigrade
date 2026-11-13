import { WorkerEntrypoint } from "cloudflare:workers"
import { WorkspaceError } from "@clavia/tardigrade-libraries/workspace/index"
import { workspaceNetworkPolicy, type WorkspaceNetworkPolicy } from "../shared/workspace/network"

interface WorkspaceNetworkProxyProps { readonly hosts: readonly string[] }

// WorkspaceNetworkProxy forwards HTTP and HTTPS to the exact hosts supplied by the workspace host.
export class WorkspaceNetworkProxy extends WorkerEntrypoint<object, WorkspaceNetworkProxyProps> {
  override async fetch(request: Request): Promise<Response> {
    const policy = workspaceNetworkPolicy({ mode: "allowlist", hosts: this.ctx.props.hosts })
    const url = new URL(request.url)
    if (policy.mode !== "allowlist" || !policy.hosts.includes(url.hostname.toLowerCase().replace(/\.$/, "")) || !["http:", "https:"].includes(url.protocol) || url.port || url.username || url.password) return new Response("Destination is outside the workspace network allowlist", { status: 403 })
    if (request.method === "CONNECT" || request.headers.has("upgrade")) return new Response("Workspace network routes support HTTP requests", { status: 405 })
    const headers = new Headers(request.headers)
    headers.delete("host")
    return fetch(new Request(url.toString(), { method: request.method, headers, body: request.body, redirect: "manual" }))
  }
}

// workspaceNetworkRoutes installs HTTP and HTTPS forwarding routes for allowlisted hosts.
export function workspaceNetworkRoutes(container: Container, ctx: DurableObjectState, policy: WorkspaceNetworkPolicy) {
  if (policy.mode !== "allowlist") return { install: async () => {} }
  const bindings = ctx.exports as { readonly WorkspaceNetworkProxy?: (options: { readonly props: WorkspaceNetworkProxyProps }) => Fetcher }
  if (typeof bindings.WorkspaceNetworkProxy !== "function") throw new WorkspaceError("Allowlisted workspaces require WorkspaceNetworkProxy to be re-exported from the Worker entrypoint")
  const proxy = bindings.WorkspaceNetworkProxy({ props: { hosts: policy.hosts } })
  return {
    install: async () => {
      for (const host of policy.hosts) {
        await container.interceptOutboundHttp(host, proxy)
        await container.interceptOutboundHttps(host, proxy)
      }
    },
  }
}
