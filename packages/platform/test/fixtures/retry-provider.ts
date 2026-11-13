import { Duration } from "effect"
import { AiError } from "effect/ai"
import { contentModelServices } from "./agent"

export function retryServices() {
  let calls = 0
  const services = contentModelServices(() => {}, {
    request: { retry: { backoffMs: [0], retryAfterJitterMs: 0, maxRetryAfterMs: 100 } },
    failure: () => ++calls === 1 ? AiError.make({ module: "Fixture", method: "streamText", reason: AiError.RateLimitError.make({ retryAfter: Duration.millis(25) }) }) : undefined,
  })
  return { services, calls: () => calls }
}
