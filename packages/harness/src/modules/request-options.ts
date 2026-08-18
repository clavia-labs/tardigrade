import { Context } from "effect"
import { RequestOptionsProjection, type RequestOptions } from "../infer"
import { defineModule } from "../module"
import type { Projection } from "../projection"
import { turnView } from "../turns"

export interface RequestOptionsModule {
  readonly id?: string
  readonly of: Projection<RequestOptions>
}

export const requestOptions = (of: Projection<RequestOptions> | RequestOptionsModule) => {
  const policy = typeof of === "function" ? { of } : of
  return defineModule({
    id: "request-options",
    version: "1",
    identity: { id: policy.id ?? "custom" },
    services: Context.make(RequestOptionsProjection, policy.of),
    setup: () => ({})
  })
}

// Flex by default. After `after` deferrals in the current turn, standard. The request is a
// projection of the log, so the same fold chooses the same tier on replay.
export const flexThenStandard = (after = 2) =>
  requestOptions({
    id: `flex-then-standard:${after}`,
    of: (log) => ({
      serviceTier:
        turnView(log).filter((event) => event.type === "ModelDeferred").length >= after
          ? "standard"
          : "flex"
    })
  })
