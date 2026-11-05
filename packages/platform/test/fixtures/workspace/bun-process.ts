import { join } from "node:path"
import { localWorkspace } from "../../../src/bun/workspace"
import { serveWorkspaceLifecycle } from "./lifecycle-process"

const directory = process.argv[2]!
await serveWorkspaceLifecycle(directory, (contentStore, store) => localWorkspace({ directory: join(directory, "files"), contentStore, idempotency: { workspaceId: "lifecycle", store } }))
