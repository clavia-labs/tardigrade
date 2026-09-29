import { Effect, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { RuntimeError, type Journal } from "@clavia/tardigrade-experimental-core"

export const InvocationEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("InvocationRequested"), key: Schema.NonEmptyString, method: Schema.NonEmptyString, args: Schema.Array(Schema.Json) }),
  Schema.Struct({ type: Schema.Literal("InvocationSettled"), key: Schema.NonEmptyString, outcome: Schema.Literals(["completed", "failed"]), error: Schema.NullOr(Schema.String) }),
])
export type InvocationEvent = typeof InvocationEvent.Type
export type InvocationReceipt = { readonly key: string } & (
  | { readonly status: "pending" | "completed" }
  | { readonly status: "failed"; readonly error: string }
)
export interface InvocationOptions { readonly key: string }
export class InvocationConflict extends Error { readonly _tag = "InvocationConflict" }
export type ThreadMethods<Methods> = {
  readonly [Key in keyof Methods]: Methods[Key] extends (...args: infer Args) => Effect.Effect<void, Error>
    ? (...args: [...Args, options: InvocationOptions]) => Effect.Effect<InvocationReceipt, Error>
    : never
}

// invocationLedger reuses settled calls and leaves interrupted calls pending until their outcome is reconciled.
export function invocationLedger(journal: Journal<InvocationEvent>) {
  return Effect.gen(function* () {
    const decode = Schema.decodeUnknownEffect(InvocationEvent, { onExcessProperty: "error" })
    let events = yield* Effect.forEach(yield* journal.read, event => decode(event).pipe(Effect.mapError(RuntimeError.from)))
    const requests = new Map<string, Extract<InvocationEvent, { type: "InvocationRequested" }>>()
    const receipts = new Map<string, InvocationReceipt>()
    for (const event of events) {
      if (event.type === "InvocationRequested") {
        if (requests.has(event.key)) return yield* Effect.fail(new RuntimeError("Duplicate invocation request"))
        requests.set(event.key, event)
        receipts.set(event.key, { key: event.key, status: "pending" })
      } else {
        if (receipts.get(event.key)?.status !== "pending") return yield* Effect.fail(new RuntimeError("Invalid invocation settlement"))
        receipts.set(event.key, event.outcome === "completed" ? { key: event.key, status: "completed" } : { key: event.key, status: "failed", error: event.error ?? "Invocation failed" })
      }
    }
    let failure: Error | undefined
    const append = (event: InvocationEvent) => Effect.gen(function* () {
      if (failure) return yield* Effect.fail(failure)
      yield* journal.append(events.length, [event]).pipe(Effect.mapError(cause => {
        failure = new RuntimeError("Invocation journal failed; reopen the host", { cause })
        return failure
      }))
      events = [...events, event]
    })
    return {
      get: (key: string) => receipts.get(key),
      invoke: (key: string, method: string, args: readonly unknown[], run: () => Effect.Effect<void, Error>): Effect.Effect<InvocationReceipt, Error> => Effect.gen(function* () {
        if (failure) return yield* Effect.fail(failure)
        const request = yield* Effect.try({ try: () => structuredClone({ type: "InvocationRequested", key, method, args }), catch: RuntimeError.from }).pipe(Effect.flatMap(decode), Effect.mapError(RuntimeError.from))
        if (request.type !== "InvocationRequested") return yield* Effect.fail(new RuntimeError("Invalid invocation request"))
        const previous = requests.get(key)
        if (previous) {
          if (!isDeepStrictEqual(previous, request)) return yield* Effect.fail(new InvocationConflict("Invocation key reused with different input"))
          return receipts.get(key)!
        }
        yield* append(request)
        requests.set(key, request)
        receipts.set(key, { key, status: "pending" })
        const error = yield* run().pipe(Effect.as(null as string | null), Effect.catch(cause => Effect.succeed(String(cause))))
        yield* append({ type: "InvocationSettled", key, outcome: error === null ? "completed" : "failed", error })
        const receipt: InvocationReceipt = error === null ? { key, status: "completed" } : { key, status: "failed", error }
        receipts.set(key, receipt)
        return receipt
      }).pipe(Effect.uninterruptible),
    }
  })
}
