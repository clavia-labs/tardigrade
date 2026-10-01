import { Effect, Schema } from "effect"
import { MessageReceipt, RuntimeError } from "@clavia/tardigrade-experimental-core"
import type { MessageTransport } from "@clavia/tardigrade-experimental-core"

// httpMessageTransport acknowledges delivery only when an endpoint returns a matching acceptance receipt.
// External receivers accept { message, body } and persist message identities before acknowledging.
export function httpMessageTransport(options: {
  readonly fetch: typeof globalThis.fetch
  readonly headers?: Readonly<Record<string, string>>
}): MessageTransport {
  return {
    deliver: (address, body, message) => Effect.gen(function* () {
      const url = yield* Schema.decodeUnknownEffect(Schema.String)(address).pipe(Effect.mapError(RuntimeError.from))
      const packet = yield* Effect.try({ try: () => JSON.stringify({ message, body }), catch: RuntimeError.from })
      const response = yield* Effect.tryPromise({
        try: signal => options.fetch(url, {
          method: "POST", headers: { ...options.headers, "content-type": "application/json", "idempotency-key": message.id },
          body: packet, signal,
        }), catch: RuntimeError.from,
      })
      if (!response.ok) return yield* Effect.fail(new RuntimeError(`Message endpoint rejected delivery: HTTP ${response.status}`))
      const value = yield* Effect.tryPromise({ try: () => response.json(), catch: RuntimeError.from })
      const receipt = yield* Schema.decodeUnknownEffect(MessageReceipt, { onExcessProperty: "error" })(value).pipe(Effect.mapError(RuntimeError.from))
      if (receipt.id !== message.id) return yield* Effect.fail(new RuntimeError("Message endpoint acknowledged a different message"))
      return receipt
    }),
  }
}
