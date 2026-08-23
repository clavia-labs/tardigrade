import { describe, expect, test } from "bun:test"
import { Data, Effect } from "effect"
import { mappedDirectory } from "@clavia/tardigrade-core/communication/directory"
import type { ActorId } from "@clavia/tardigrade-core/communication/endpoint"
import type { ActorEnvelope } from "@clavia/tardigrade-core/communication/envelope"
import type { MessageReceived } from "@clavia/tardigrade-core/communication/message"
import { ActorUnavailable, Ingress, ingressFrom, type IngressActor } from "./ingress"
import { handleWebhook, type Webhook, type WebhookRequest, type WebhookResult } from "./webhook"

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

const request: WebhookRequest = {
  method: "POST",
  url: "https://example.test/webhooks/example",
  headers: { "content-type": "application/json" },
  body: bytes("{}"),
  receivedAt: 42
}

const webhook = <E = never>(receive: () => Effect.Effect<WebhookResult, E>): Webhook<never, E> => ({
  name: "example",
  receive
})

const run = <E>(source: Webhook<never, E>, committed: Array<ActorEnvelope<MessageReceived>> = []) =>
  handleWebhook(source, request).pipe(
    Effect.provideService(
      Ingress,
      ingressFrom(mappedDirectory(() => ({
        commit: (delivery) => Effect.sync(() => committed.push(delivery)),
        schedule: Effect.void
      })))
    ),
    Effect.runPromise
  )

describe("handleWebhook", () => {
  test("returns a challenge response with no delivery", async () => {
    const committed: Array<ActorEnvelope<MessageReceived>> = []
    const response = await run(
      webhook(() => Effect.succeed({
        envelopes: [],
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          body: bytes('{"challenge":"proof"}')
        }
      })),
      committed
    )

    expect(response.status).toBe(200)
    expect(new TextDecoder().decode(response.body)).toBe('{"challenge":"proof"}')
    expect(committed).toEqual([])
  })

  test("returns the acknowledgement for a valid ignored event", async () => {
    const committed: Array<ActorEnvelope<MessageReceived>> = []
    const response = await run(
      webhook(() => Effect.succeed({ envelopes: [], response: { status: 204 } })),
      committed
    )

    expect(response).toEqual({ status: 204 })
    expect(committed).toEqual([])
  })

  test("commits envelopes before returning the response", async () => {
    const order: string[] = []
    const delivery: ActorEnvelope<MessageReceived> = {
      link: {
        source: { provider: "example" },
        target: { actor: "support", thread: "incident" }
      },
      event: { type: "MessageReceived", id: "m1", text: "hello", at: 42 }
    }
    const source = webhook(() =>
      Effect.sync(() => {
        order.push("receive")
        return { envelopes: [delivery], response: { status: 202 } }
      })
    )
    const effect = handleWebhook(source, request).pipe(
      Effect.provideService(Ingress, {
        commit: () => Effect.sync(() => order.push("commit")),
        schedule: () => Effect.sync(() => order.push("schedule"))
      })
    )

    const response = await Effect.runPromise(effect)
    order.push("return")

    expect(response).toEqual({ status: 202 })
    expect(order).toEqual(["receive", "commit", "schedule", "return"])
  })

  test("a webhook failure commits nothing and returns no response", async () => {
    class Refused extends Data.TaggedError("Refused")<{}> {}
    const committed: Array<ActorEnvelope<MessageReceived>> = []
    const error = await run(webhook(() => Effect.fail(new Refused())), committed).then(
      () => undefined,
      (failure: unknown) => failure
    )

    expect(error).toBeInstanceOf(Error)
    expect(committed).toEqual([])
  })

  test("an unavailable delivery actor prevents the response", async () => {
    const delivery: ActorEnvelope<MessageReceived> = {
      link: {
        source: { provider: "example" },
        target: { actor: "missing", thread: "incident" }
      },
      event: { type: "MessageReceived", id: "m1", text: "hello", at: 42 }
    }
    const error = await Effect.runPromise(
      handleWebhook(
        webhook(() => Effect.succeed({ envelopes: [delivery], response: { status: 202 } })),
        request
      ).pipe(
        Effect.provideService(Ingress, ingressFrom(mappedDirectory<ActorId, IngressActor>(() => undefined))),
        Effect.flip
      )
    )

    expect(error).toEqual(new ActorUnavailable({ actor: "missing" }))
  })
})
