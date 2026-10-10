import { test } from "bun:test"
import { retryScenarios } from "../properties/retries/lifecycle"
import { bunRetryFixture } from "../fixtures/bun/retry-fixture"

for (const scenario of retryScenarios) test(scenario.name, async () => {
  const fixture = await bunRetryFixture(scenario.options)
  try { await scenario.run(fixture) } finally { await fixture.close() }
})
