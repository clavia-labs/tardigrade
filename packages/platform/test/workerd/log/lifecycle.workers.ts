import { test } from "vitest"
import { cloudflareLogLifecycle } from "../../fixtures/log/cloudflare"
import { LOG_SCENARIO_TIMEOUT_MS } from "../../fixtures/log/shared"
import { logLifecycle } from "../../scenarios/log/lifecycle"

// eslint-disable-next-line no-empty-pattern -- Vitest requires destructuring for fixtures without dependencies.
const scenarioTest = test.extend("log", async ({}, { onCleanup }) => {
  const driver = await cloudflareLogLifecycle()
  onCleanup(() => driver.close())
  return driver
})

scenarioTest("schema discovery and read-only recall survive a lost reply and checkpointed process death", { timeout: LOG_SCENARIO_TIMEOUT_MS }, async ({ log }) => {
  await logLifecycle(log)
})
