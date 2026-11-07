import { afterAll, test } from "bun:test"
import { bunWorkspaceLifecycle } from "../../fixtures/workspace/bun"
import { BOXD_LIVE_STAGE_MS, BOXD_LIVE_TIMEOUT_MS, liveBoxd, liveName, removeComputer } from "../../fixtures/workspace/boxd-live"
import { workspaceScenarios } from "../../scenarios/workspace/lifecycle"

const { client, org } = liveBoxd()
afterAll(() => client.close())

test.each([...workspaceScenarios])("$name", async scenario => {
  const name = liveName("scenario")
  const driver = await bunWorkspaceLifecycle(new URL("../../fixtures/workspace/boxd-process.ts", import.meta.url), [name], BOXD_LIVE_STAGE_MS)
  try { await scenario.run(driver) } finally { try { await driver.close() } finally { await removeComputer(client, org, name) } }
}, BOXD_LIVE_TIMEOUT_MS)
