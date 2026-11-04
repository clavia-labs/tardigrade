import { test } from "bun:test"
import { bunWorkspaceLifecycle } from "../../fixtures/workspace/bun"
import { workspaceScenarios } from "../../scenarios/workspace/lifecycle"
import { WORKSPACE_SCENARIO_TIMEOUT_MS } from "../../fixtures/workspace/shared"

test.each([...workspaceScenarios])("$name", async scenario => {
  const driver = await bunWorkspaceLifecycle()
  try { await scenario.run(driver) } finally { await driver.close() }
}, WORKSPACE_SCENARIO_TIMEOUT_MS)
