import assert from "node:assert/strict"
import { test } from "bun:test"
import { DEFAULT_LIVE_TIMEOUT_MS, positive, resolveTarget, selectedTargetIds, type ResolvedLiveTarget } from "./config"
import { targetById } from "../targets"

export const liveSuite = (boundary: string, run: (target: ResolvedLiveTarget) => Promise<unknown>) => {
  const enabled = process.env.TARDIE_LIVE === "1"
  const ids = enabled ? selectedTargetIds() : []
  const timeout = enabled ? positive("TARDIE_LIVE_TIMEOUT_MS", DEFAULT_LIVE_TIMEOUT_MS) : DEFAULT_LIVE_TIMEOUT_MS
  if (enabled) assert.ok(ids.length > 0, "Set TARDIE_LIVE_TARGETS to one or more target IDs")
  if (!enabled) test.skip(`${boundary}: live inference requires explicit opt-in`, () => {})
  for (const id of ids) test(`${boundary}: ${id}`, async () => {
    const target = targetById(id)
    assert.ok(target, `Unknown live target ${JSON.stringify(id)}`)
    await run(resolveTarget(target))
  }, timeout + 10_000)
}
