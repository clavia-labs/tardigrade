import assert from "node:assert/strict"
import { test } from "bun:test"
import { DEFAULT_LIVE_TIMEOUT_MS, positive, resolveTarget, selectedTargetIds } from "./support/config"
import { runLifecycle } from "./support/recovery"
import { targetById } from "./targets"

if (process.env.TARDIE_LIVE !== "1") test.skip("Conversation lifecycle: live inference requires explicit opt-in", () => {})
else test("Conversation lifecycle: tool evolution, reasoning replay, restart, and provider handoff", async () => {
  const ids = selectedTargetIds()
  assert.ok(ids.length >= 2, "Select at least two TARDIE_LIVE_TARGETS for a provider handoff")
  const targets = ids.map((id) => {
    const target = targetById(id)
    assert.ok(target, `Unknown live target ${JSON.stringify(id)}`)
    return resolveTarget(target)
  })
  await runLifecycle(targets)
}, positive("TARDIE_LIVE_TIMEOUT_MS", DEFAULT_LIVE_TIMEOUT_MS) + 10_000)
