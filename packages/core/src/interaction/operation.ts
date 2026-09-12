import { Effect } from "effect"
import { InvocationSuspended } from "../runtime/context"

export type OperationRead<Result> =
  | { readonly status: "pending"; readonly awaiting: string }
  | { readonly status: "completed"; readonly result: Result }

export interface OperationAdapter<Request, Reference, Result, Error, Requirements, CancelRequest = never, CancelResult = never> {
  // start records acceptance under the adapter's durable key before it returns.
  readonly start: (request: Request) => Effect.Effect<Reference, Error, Requirements>
  // read validates the reference and reports the stable wait key the adapter's durable wake targets.
  readonly read: (reference: Reference) => Effect.Effect<OperationRead<Result>, Error, Requirements>
  readonly cancel?: (reference: Reference, request: CancelRequest) => Effect.Effect<CancelResult, Error, Requirements>
}

// OperationHandle carries the reference an adapter assigned to accepted work. The caller must choose a reference that its durable execution boundary can serialize.
export interface OperationHandle<Reference> {
  readonly reference: Reference
}

// durableOperations binds adapter code to replay-stable handles without storing the adapter in them. Awaiting a pending handle parks the action, and a later wake re-executes that action from its start, so work between start and await must use keyed durable effects (packages/host/src/invocation.test.ts, "split calls to existing threads release a single host slot and replay without redispatch"). The adapter owns keyed acceptance, reference validation, terminal decoding, and wake delivery.
export const durableOperations = <Request, Reference, Result, Error, Requirements, CancelRequest = never, CancelResult = never>(
  adapter: OperationAdapter<Request, Reference, Result, Error, Requirements, CancelRequest, CancelResult>
) => {
  const cancel = adapter.cancel
  return {
    start: (request: Request): Effect.Effect<OperationHandle<Reference>, Error, Requirements> =>
      adapter.start(request).pipe(Effect.map((reference) => ({ reference }))),
    await: (handle: OperationHandle<Reference>): Effect.Effect<Result, Error, Requirements> =>
      adapter.read(handle.reference).pipe(Effect.flatMap((state) => state.status === "completed"
        ? Effect.succeed(state.result)
        : Effect.die(new InvocationSuspended(state.awaiting)))),
    ...(cancel === undefined ? {} : {
    cancel: (handle: OperationHandle<Reference>, request: CancelRequest): Effect.Effect<CancelResult, Error, Requirements> =>
        cancel(handle.reference, request)
    })
  }
}
