import { test } from "bun:test"
import { bunLogLifecycle } from "../../fixtures/log/bun"
import { LOG_SCENARIO_TIMEOUT_MS } from "../../fixtures/log/shared"
import { logLifecycle } from "../../scenarios/log/lifecycle"

test("schema discovery and read-only recall survive a lost reply and checkpointed process death", async () => {
  const driver = await bunLogLifecycle()
  try { await logLifecycle(driver) } finally { await driver.close() }
}, LOG_SCENARIO_TIMEOUT_MS)
