import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Transport } from "@clavia/tardigrade-core/communication/transport"
import { deliveryOf } from "@clavia/tardigrade-core/communication/delivery"
import type { MessageReceived } from "@clavia/tardigrade-core/communication/message"
import { createHost } from "../host"

const message: MessageReceived = {
  type: "MessageReceived",
  id: "m1.reply",
  text: "fixed",
  at: 42
}

describe("host providers", () => {
  test("routes a provider link through its configured provider", async () => {
    const sent: Array<{ readonly target: unknown; readonly message: MessageReceived }> = []
    const host = createHost({
      actorFor: () => undefined,
      providers: [{
        name: "telegram-support",
        send: (target, outbound) =>
          Effect.sync(() => sent.push({ target, message: outbound }))
      }]
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* Transport
        yield* transport.deliver(deliveryOf(
          {
            source: { actor: "support", thread: "incident" },
            target: { provider: "telegram-support", chat: "-100123", topic: 42 }
          },
          message
        ))
      }).pipe(Effect.provide(host.transport))
    )

    expect(sent).toEqual([{
      target: { provider: "telegram-support", chat: "-100123", topic: 42 },
      message
    }])
  })

  test("rejects an unavailable provider", async () => {
    const host = createHost({ actorFor: () => undefined })
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const transport = yield* Transport
        yield* transport.deliver(deliveryOf(
          {
            source: { actor: "support", thread: "incident" },
            target: { provider: "missing" }
          },
          message
        ))
      }).pipe(Effect.provide(host.transport))
    )

    expect(exit._tag).toBe("Failure")
  })
})
