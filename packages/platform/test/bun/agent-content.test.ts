import { test } from "bun:test"
import { contentScenarios } from "../properties/content/hydration"
import { bunContentFixture } from "../fixtures/bun/content-fixture"

for (const scenario of contentScenarios) test(scenario.name, async () => {
  const fixture = await bunContentFixture()
  try { await scenario.run(fixture) } finally { await fixture.close() }
})
