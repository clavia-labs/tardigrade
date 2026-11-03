import { FilesystemWorkspaceError } from "@clavia/tardigrade-libraries/filesystem/index"

export type WorkspaceNetworkPolicy =
  | { readonly mode: "none" }
  | { readonly mode: "all" }
  | { readonly mode: "allowlist"; readonly hosts: readonly string[] }

export const DEFAULT_WORKSPACE_NETWORK_POLICY: WorkspaceNetworkPolicy = Object.freeze({ mode: "none" })

// workspaceNetworkPolicy validates general internet access and normalizes exact DNS hostnames.
export function workspaceNetworkPolicy(policy: WorkspaceNetworkPolicy = DEFAULT_WORKSPACE_NETWORK_POLICY): WorkspaceNetworkPolicy {
  if (policy?.mode === "none" || policy?.mode === "all") return { mode: policy.mode }
  if (policy?.mode !== "allowlist") throw new FilesystemWorkspaceError("Workspace network mode must be none, all, or allowlist")
  if (!Array.isArray(policy.hosts) || policy.hosts.length === 0) throw new FilesystemWorkspaceError("Workspace network allowlist requires at least one hostname")
  const hosts = policy.hosts.map((value: unknown) => {
    if (typeof value !== "string" || !value || /[\s/:?#@\\*%]/.test(value)) throw new FilesystemWorkspaceError("Workspace network hosts must be exact DNS hostnames without wildcards, ports, or URL components")
    let host: string
    try { host = new URL(`http://${value}`).hostname.toLowerCase().replace(/\.$/, "") } catch (cause) {
      throw new FilesystemWorkspaceError("Invalid workspace network hostname", { cause })
    }
    if (host.length > 253 || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new FilesystemWorkspaceError(`Invalid workspace network DNS hostname: ${value}`)
    return host
  })
  return { mode: "allowlist", hosts: [...new Set(hosts)].sort() }
}
