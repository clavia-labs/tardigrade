import { Effect } from "effect"
import { WorkspaceError, type WorkspaceIdempotencyStore } from "@clavia/tardigrade-libraries/workspace/index"
import type { Fault } from "./protocol"

// workspaceFaultStore applies shared failure boundaries around a real idempotency store.
export function workspaceFaultStore(store: WorkspaceIdempotencyStore, readFault: () => Fault, interrupt: (fault: Fault) => Effect.Effect<never>): WorkspaceIdempotencyStore {
  return {
    claim: request => Effect.gen(function* () {
      const fault = readFault()
      if (fault === "claimFailure") return yield* Effect.fail(new WorkspaceError("Injected claim storage failure"))
      const claim = yield* store.claim(request)
      if (claim._tag === "Acquired" && fault === "afterClaim") return yield* interrupt(fault)
      return claim
    }),
    complete: (request, outcome) => Effect.gen(function* () {
      const fault = readFault()
      if (fault === "beforeComplete") return yield* interrupt(fault)
      yield* store.complete(request, outcome)
      if (fault === "afterComplete") return yield* interrupt(fault)
    }),
  }
}
