import { expect, test } from "bun:test"
import fc from "fast-check"
import { retryDelayOf, type RequestPolicy } from "./retry"

const policy: RequestPolicy = { maxOutputTokens: 100, timeout: { firstChunkMs: 90_000, idleMs: 90_000 }, retry: { backoffMs: [0], maxRetryAfterMs: 1000, retryAfterJitterMs: 0 } }

test("retry delays obey the explicit provider wait limit independently of backoff", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 1000 }), fc.double({ min: 0, max: 1, noNaN: true }), (base, minimum, random) => {
    const configured = { ...policy, retry: { backoffMs: [base], maxRetryAfterMs: 500, retryAfterJitterMs: 10 } }
    expect(retryDelayOf(configured, 1, undefined, random)).toBeUndefined()
    const delay = retryDelayOf(configured, 0, minimum, random)
    if (minimum > 500) expect(delay).toBeUndefined()
    else { expect(delay).toBeGreaterThanOrEqual(minimum); expect(delay).toBeLessThanOrEqual(minimum + 10) }
  }))
})
