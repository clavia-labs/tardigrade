import { describe, expect, test } from "bun:test"

import { providerAvailabilitiesOf, providerAvailabilityOf } from "./catalog-availability"

describe("provider availability", () => {
  test("describes usable, incomplete, and absent provider connections", () => {
    const availability = providerAvailabilitiesOf({
      allow: "*",
      providers: {
        ready: { baseUrl: "https://ready.test", protocol: "openai-responses", env: ["READY_KEY"] },
        incomplete: { baseUrl: "https://incomplete.test", protocol: "openai-responses", env: ["MISSING_KEY"] }
      }
    }, { READY_KEY: "secret" })

    expect(availability).toEqual({
      ready: { status: "available" },
      incomplete: { status: "unavailable", reason: "credential_missing" }
    })
    expect(providerAvailabilityOf(availability, "absent")).toEqual({
      status: "unavailable",
      reason: "not_configured"
    })
  })
})
