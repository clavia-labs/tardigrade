import { test } from "vitest"
import { retryScenarios } from "../properties/retries/lifecycle"
import { workerdRetryFixture } from "../fixtures/workerd/retry-fixture"

for (const scenario of retryScenarios) test(scenario.name, async () => {
  const fixture = await workerdRetryFixture(scenario.options)
  try { await scenario.run(fixture) } finally { await fixture.close() }
})
