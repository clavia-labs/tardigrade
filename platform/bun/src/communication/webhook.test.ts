import { describe, expect, test } from "bun:test"
import { Context, Effect } from "effect"
import type { ActorEnvelope } from "@clavia/tardigrade-core/communication/envelope"
import type { MessageReceived } from "@clavia/tardigrade-core/communication/message"
import { Ingress } from "@clavia/tardigrade-host/ingress"
import type { Webhook } from "@clavia/tardigrade-host/webhook"
import { bunChannelHandler, handleBunWebhook, webhookRequestFrom, webhookResponseFrom } from "./webhook"
import { channelOf } from "@clavia/tardigrade-host/communication/channel"

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

describe("Bun webhooks", () => {
  test("captures the real request without changing its body", async () => {
    const body = new Uint8Array([0, 255, 13, 10, 42])
    const request = new Request("https://example.test/hooks/slack?team=T1", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Signature": "signed"
      },
      body
    })

    const captured = await Effect.runPromise(webhookRequestFrom(request, 42))

    expect(captured).toEqual({
      method: "POST",
      url: "https://example.test/hooks/slack?team=T1",
      headers: {
        "content-type": "application/octet-stream",
        "x-signature": "signed"
      },
      body,
      receivedAt: 42
    })
  })

  test("commits and schedules envelopes before returning an HTTP response", async () => {
    const order: string[] = []
    const delivery: ActorEnvelope<MessageReceived> = {
      link: {
        source: { provider: "example" },
        target: { actor: "support", instance: "main", thread: "incident" }
      },
      event: { type: "MessageReceived", id: "m1", text: "hello", at: 42 }
    }
    const webhook: Webhook = {
      name: "example",
      receive: (request) => Effect.sync(() => {
        order.push(`receive:${new TextDecoder().decode(request.body)}`)
        return {
          envelopes: [delivery],
          response: {
            status: 202,
            headers: { "x-accepted": "yes" },
            body: bytes("accepted")
          }
        }
      })
    }
    const ingress: Context.Service.Shape<typeof Ingress> = {
      commit: () => Effect.sync(() => order.push("commit")),
      schedule: () => Effect.sync(() => order.push("schedule"))
    }
    const effect = handleBunWebhook(
      webhook,
      new Request("https://example.test/hooks/example", { method: "POST", body: "payload" })
    ).pipe(Effect.provideService(Ingress, ingress))

    const response = await Effect.runPromise(effect)
    order.push("return")

    expect(response.status).toBe(202)
    expect(response.headers.get("x-accepted")).toBe("yes")
    expect(await response.text()).toBe("accepted")
    expect(order).toEqual(["receive:payload", "commit", "schedule", "return"])
  })

  test("creates a bodyless response", async () => {
    const response = webhookResponseFrom({ status: 204 })

    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
  })

  test("binds a channel and ingress service as an HTTP handler", async () => {
    const committed: Array<ActorEnvelope<MessageReceived>> = []
    const channel = channelOf(
      {
        name: "example",
        receive: () => Effect.succeed({
          inbound: [{
            source: { provider: "example", chat: "c1" },
            event: { type: "MessageReceived", id: "m1", text: "hello", at: 42 }
          }],
          response: { status: 200 }
        }),
        send: () => Effect.void
      },
      () => ({ actor: "support", instance: "main", thread: "incident" }),
      { method: "message" }
    )
    const handler = bunChannelHandler(channel, {
      commit: (envelopes) => Effect.sync(() => committed.push(...envelopes)),
      schedule: () => Effect.void
    })

    const response = await handler(new Request("https://example.test/hooks/example", { method: "POST" }))

    expect(response.status).toBe(200)
    expect(committed[0]?.link).toEqual({
      source: { provider: "example", chat: "c1" },
      target: { actor: "support", instance: "main", thread: "incident" }
    })
  })
})
