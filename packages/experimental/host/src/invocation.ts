import { Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import type { Journal } from "@clavia/tardigrade-experimental-core"

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
  readonly [Key in keyof Methods]: Methods[Key] extends (...args: infer Args) => Promise<void>
    ? (...args: [...Args, options: InvocationOptions]) => Promise<InvocationReceipt>
    : never
}

// invocationLedger reuses settled calls and leaves interrupted calls pending until their outcome is reconciled.
export async function invocationLedger(journal: Journal<InvocationEvent>) {
  const decode = Schema.decodeUnknownSync(InvocationEvent, { onExcessProperty: "error" })
  let events = (await journal.read()).map(event => decode(event))
  const requests = new Map<string, Extract<InvocationEvent, { type: "InvocationRequested" }>>()
  const receipts = new Map<string, InvocationReceipt>()
  for (const event of events) {
    if (event.type === "InvocationRequested") {
      if (requests.has(event.key)) throw new Error("Duplicate invocation request")
      requests.set(event.key, event)
      receipts.set(event.key, { key: event.key, status: "pending" })
    } else {
      if (receipts.get(event.key)?.status !== "pending") throw new Error("Invalid invocation settlement")
      receipts.set(event.key, event.outcome === "completed" ? { key: event.key, status: "completed" } : { key: event.key, status: "failed", error: event.error ?? "Invocation failed" })
    }
  }
  let failure: Error | undefined
  const append = async (event: InvocationEvent) => {
    if (failure) throw failure
    try { await journal.append(events.length, [event]) } catch (cause) {
      failure = new Error("Invocation journal failed; reopen the host", { cause })
      throw failure
    }
    events = [...events, event]
  }
  return {
    get: (key: string) => receipts.get(key),
    invoke: async (key: string, method: string, args: readonly unknown[], run: () => Promise<void>): Promise<InvocationReceipt> => {
      if (failure) throw failure
      const request = decode(structuredClone({ type: "InvocationRequested", key, method, args }))
      if (request.type !== "InvocationRequested") throw new Error("Invalid invocation request")
      const previous = requests.get(key)
      if (previous) {
        if (!isDeepStrictEqual(previous, request)) throw new InvocationConflict("Invocation key reused with different input")
        return receipts.get(key)!
      }
      await append(request)
      requests.set(key, request)
      receipts.set(key, { key, status: "pending" })
      let error: string | null = null
      try { await run() } catch (cause) { error = String(cause) }
      await append({ type: "InvocationSettled", key, outcome: error === null ? "completed" : "failed", error })
      const receipt: InvocationReceipt = error === null ? { key, status: "completed" } : { key, status: "failed", error }
      receipts.set(key, receipt)
      return receipt
    },
  }
}
