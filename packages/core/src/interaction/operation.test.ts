import { expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { InvocationSuspended } from "../runtime/context"
import { durableOperations } from "./operation"

test("a rebound adapter resumes the serialized handle at its exact wait key", async () => {
  const terminals = new Map<string, string>()
  const adapter = () => ({
    start: (request: { readonly key: string }) => Effect.succeed(request.key),
    read: (reference: string) => Effect.succeed(terminals.has(reference)
      ? { status: "completed" as const, result: terminals.get(reference)! }
      : { status: "pending" as const, awaiting: `reply:${reference}` })
  })
  const first = durableOperations(adapter())
  const handle = await Effect.runPromise(first.start({ key: "approval-1" }))
  expect(JSON.parse(JSON.stringify(handle))).toEqual({ reference: "approval-1" })
  const parked = await Effect.runPromiseExit(first.await(handle))
  expect(Exit.isFailure(parked) ? Cause.squash(parked.cause) : undefined)
    .toEqual(new InvocationSuspended("reply:approval-1"))
  terminals.set("approval-1", "approved")
  const rebound = durableOperations(adapter())
  expect(await Effect.runPromise(rebound.await(handle))).toBe("approved")
  expect(await Effect.runPromise(rebound.await(handle))).toBe("approved")
})

test("completion before await is read without parking", async () => {
  const operations = durableOperations({
    start: (request: { readonly id: string; readonly result: number }) => Effect.succeed(request),
    read: (reference: { readonly id: string; readonly result: number }) =>
      Effect.succeed({ status: "completed" as const, result: reference.result })
  })
  const handle = await Effect.runPromise(operations.start({ id: "background-1", result: 42 }))
  expect(await Effect.runPromise(operations.await(handle))).toBe(42)
})
