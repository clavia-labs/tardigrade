import { test } from "vitest"
import { contentScenarios } from "../properties/content/hydration"
import { workerdContentFixture } from "./content-fixture"

for (const scenario of contentScenarios) test(scenario.name, async () => {
  const fixture = await workerdContentFixture()
  try { await scenario.run(fixture) } finally { await fixture.close() }
})
