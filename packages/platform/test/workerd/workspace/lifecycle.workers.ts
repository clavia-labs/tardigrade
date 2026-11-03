import { test } from "vitest"
import { cloudflareWorkspaceLifecycle } from "../../fixtures/workspace/cloudflare"
import { workspaceScenarios } from "../../scenarios/workspace/lifecycle"
import { WORKSPACE_SCENARIO_TIMEOUT_MS } from "../../fixtures/workspace/shared"

// eslint-disable-next-line no-empty-pattern -- Vitest requires destructuring for fixtures without dependencies.
const scenarioTest = test.extend("workspace", async ({}, { onCleanup }) => {
  const driver = await cloudflareWorkspaceLifecycle()
  onCleanup(() => driver.close())
  return driver
})

scenarioTest.for(workspaceScenarios)("$name", { timeout: WORKSPACE_SCENARIO_TIMEOUT_MS }, async (scenario, { workspace }) => {
  await scenario.run(workspace)
})
