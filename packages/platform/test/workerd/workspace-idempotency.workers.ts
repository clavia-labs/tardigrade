import { test } from "vitest"
import * as fc from "fast-check"
import { cloudflareWorkspaceIdempotency } from "../fixtures/workerd/workspace-idempotency"
import { workspaceFileMutationReplay, workspaceIdempotencyActions, workspaceIdempotencyHistory } from "../properties/workspace/idempotency"
import { RUNTIME_PROPERTY_OPTIONS, RUNTIME_PROPERTY_WORKER_TEST_TIMEOUT_MS } from "../properties/runtime/config"

const options = { ...RUNTIME_PROPERTY_OPTIONS, numRuns: 100 }

test("workspace mutation safety and conditional liveness survive DO abort", () => fc.assert(fc.asyncProperty(workspaceIdempotencyActions, async actions => {
  const fixture = await cloudflareWorkspaceIdempotency()
  try { await workspaceIdempotencyHistory(actions, fixture) } finally { await fixture.close() }
}), options), RUNTIME_PROPERTY_WORKER_TEST_TIMEOUT_MS)

test("workspace file mutations replay saved outcomes through DO RPC after abort", () => fc.assert(fc.asyncProperty(fc.stringMatching(/^[a-z0-9]{1,16}$/), async content => {
  const fixture = await cloudflareWorkspaceIdempotency()
  try { await workspaceFileMutationReplay(content, fixture) } finally { await fixture.close() }
}), options), RUNTIME_PROPERTY_WORKER_TEST_TIMEOUT_MS)
