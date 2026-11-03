import { test } from "bun:test"
import * as fc from "fast-check"
import { bunWorkspaceIdempotency } from "../fixtures/bun/workspace-idempotency"
import { workspaceFileMutationReplay, workspaceIdempotencyActions, workspaceIdempotencyHistory } from "../properties/workspace/idempotency"
import { RUNTIME_PROPERTY_OPTIONS, RUNTIME_PROPERTY_TEST_TIMEOUT_MS } from "../properties/runtime/config"

const options = { ...RUNTIME_PROPERTY_OPTIONS, numRuns: 20 }

test("workspace mutation safety and conditional liveness survive process death", () => fc.assert(fc.asyncProperty(workspaceIdempotencyActions, async actions => {
  const fixture = await bunWorkspaceIdempotency()
  try { await workspaceIdempotencyHistory(actions, fixture) } finally { await fixture.close() }
}), options), RUNTIME_PROPERTY_TEST_TIMEOUT_MS)

test("workspace file mutations replay saved success and failure outcomes", () => fc.assert(fc.asyncProperty(fc.stringMatching(/^[a-z0-9]{1,16}$/), async content => {
  const fixture = await bunWorkspaceIdempotency()
  try { await workspaceFileMutationReplay(content, fixture) } finally { await fixture.close() }
}), options), RUNTIME_PROPERTY_TEST_TIMEOUT_MS)
