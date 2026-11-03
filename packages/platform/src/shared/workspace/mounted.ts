import { makeContainerWorkspace, type ContainerWorkspaceOptions, type WorkspaceMount } from "./container"

// mountedWorkspace supplies container operations after the configured storage mounts are ready.
export const mountedWorkspace = (options: ContainerWorkspaceOptions & { readonly mount?: WorkspaceMount }) => makeContainerWorkspace(options, options.mount)
