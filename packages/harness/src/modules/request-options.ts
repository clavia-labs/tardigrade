import { Context } from "effect"
import { RequestOptionsProjection, type RequestOptions } from "../infer"
import { defineModule } from "../module"
import type { Projection } from "../projection"

export interface RequestOptionsModule {
  readonly id?: string
  readonly of: Projection<RequestOptions>
}

// Per-request provider settings, as a fold over the log. The request is a projection, so a policy
// that reads what has already happened stays one: a rule like "ask for more thinking after the
// answer was rejected", or "leave the cheap queue after it has made this turn wait twice", is a
// pure function of the log, and a replay of that log sends what the run it replays sent.
//
// The framework ships no such policy. Which tier is worth its latency, and what the tier is called,
// belong to a deployment and to the provider it uses, and a default here would be one vendor's word
// applied to every model at once.
export const requestOptions = (of: Projection<RequestOptions> | RequestOptionsModule) => {
  const policy = typeof of === "function" ? { of } : of
  return defineModule({
    id: "request-options",
    version: "2",
    identity: { id: policy.id ?? "custom" },
    services: Context.make(RequestOptionsProjection, policy.of),
    setup: () => ({})
  })
}
