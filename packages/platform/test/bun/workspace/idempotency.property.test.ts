import { test } from "bun:test"
import * as fc from "fast-check"
import { inProcessWorkspaceIdempotency } from "../../fixtures/workspace/in-process"
import { workspaceFileMutationReplay, workspaceIdempotencyActions, workspaceIdempotencyExample, workspaceIdempotencyHistory } from "../../properties/workspace/idempotency"
import { RUNTIME_PROPERTY_OPTIONS, RUNTIME_PROPERTY_TEST_TIMEOUT_MS } from "../../properties/runtime/config"

test("generated mutation histories match the model through the SQL store", () => fc.assert(fc.asyncProperty(workspaceIdempotencyActions, async actions => {
  const fixture = await inProcessWorkspaceIdempotency()
  try { await workspaceIdempotencyHistory(actions, fixture) } finally { await fixture.close() }
}), { ...RUNTIME_PROPERTY_OPTIONS, examples: [[workspaceIdempotencyExample]] }), RUNTIME_PROPERTY_TEST_TIMEOUT_MS)

test("generated file contents preserve saved success and failure outcomes", () => fc.assert(fc.asyncProperty(fc.stringMatching(/^[a-z0-9]{1,16}$/), async content => {
  const fixture = await inProcessWorkspaceIdempotency()
  try { await workspaceFileMutationReplay(content, fixture) } finally { await fixture.close() }
}), RUNTIME_PROPERTY_OPTIONS), RUNTIME_PROPERTY_TEST_TIMEOUT_MS)
