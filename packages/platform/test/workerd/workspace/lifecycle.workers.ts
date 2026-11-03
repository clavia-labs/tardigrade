import { test } from "vitest"
import { cloudflareWorkspaceLifecycle } from "../../fixtures/workspace/cloudflare"
import { workspaceLifecycle } from "../../scenarios/workspace/lifecycle"

test("an artifact and one keyed change survive a lost reply and DO abort", async () => {
  const driver = await cloudflareWorkspaceLifecycle()
  try { await workspaceLifecycle(driver) } finally { await driver.close() }
}, 30_000)
