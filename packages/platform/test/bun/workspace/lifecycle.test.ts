import { test } from "bun:test"
import { bunWorkspaceLifecycle } from "../../fixtures/workspace/bun"
import { workspaceLifecycle } from "../../scenarios/workspace/lifecycle"

test("an artifact and one keyed change survive a lost reply and process death", async () => {
  const driver = await bunWorkspaceLifecycle()
  try { await workspaceLifecycle(driver) } finally { await driver.close() }
})
