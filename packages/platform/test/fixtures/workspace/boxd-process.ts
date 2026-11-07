import { Boxd } from "@boxd-sh/sdk"
import { boxdWorkspace } from "../../../src/boxd/workspace"
import { serveWorkspaceLifecycle } from "./lifecycle-process"

const org = process.env.BOXD_ORG
const client = new Boxd()
try {
  await serveWorkspaceLifecycle(process.argv[2]!, (contentStore, idempotency) => boxdWorkspace({ client, name: process.argv[3]!, ...(org ? { org } : {}), release: "unmount", contentStore, idempotency }))
} finally { client.close() }
