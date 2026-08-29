import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { WebhookRequest } from "@clavia/tardigrade-host/communication/webhook"
import { telegram } from "./telegram"

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

const request = (body: unknown, secret = "secret_token"): WebhookRequest => ({
  method: "POST",
  url: "https://example.test/webhooks/telegram",
  headers: { "x-telegram-bot-api-secret-token": secret },
  body: bytes(body),
  receivedAt: 42
})

describe("telegram", () => {
  test("derives a linked actor delivery from a text update", async () => {
    const channel = telegram({
      name: "telegram-support",
      token: "token",
      secretToken: "secret_token",
      target: (source) => ({ actor: "support", instance: "main", thread: `telegram:${source.chat}:${source.topic ?? "main"}` })
    })

    const result = await Effect.runPromise(channel.webhook.receive(request({
      update_id: 9001,
      message: {
        message_id: 7,
        message_thread_id: 42,
        date: 1_700_000_000,
        text: "deploy failed",
        from: { id: 99 },
        chat: { id: -100123 }
      }
    })))

    expect(result).toEqual({
      envelopes: [{
        call: { method: "message", id: "telegram:9001" },
        link: {
          source: {
            provider: "telegram-support",
            chat: "-100123",
            topic: 42,
            sender: "99"
          },
          target: { actor: "support", instance: "main", thread: "telegram:-100123:42" }
        },
        event: {
          type: "MessageReceived",
          id: "telegram:9001",
          text: "deploy failed",
          source: "telegram-support",
          chat: "-100123",
          sender: "99",
          data: {
            update_id: 9001,
            message: {
              message_id: 7,
              message_thread_id: 42,
              date: 1_700_000_000,
              text: "deploy failed",
              from: { id: 99 },
              chat: { id: -100123 }
            }
          },
          at: 1_700_000_000_000
        }
      }],
      response: { status: 200 }
    })
  })

  test("rejects a webhook with the wrong secret", async () => {
    const channel = telegram({
      name: "telegram-support",
      token: "token",
      secretToken: "secret_token",
      target: () => ({ actor: "support", instance: "main", thread: "main" })
    })

    const result = await Effect.runPromise(channel.webhook.receive(request({}, "wrong")))

    expect(result).toEqual({ envelopes: [], response: { status: 401 } })
  })

  test("sends a reply to the persisted chat and topic", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = []
    const channel = telegram({
      name: "telegram-support",
      token: "token",
      secretToken: "secret_token",
      apiBaseUrl: "https://telegram.test/",
      fetch: async (input, init) => {
        calls.push({ url: String(input), ...(init === undefined ? {} : { init }) })
        return Response.json({ ok: true, result: { message_id: 8 } })
      },
      target: () => ({ actor: "support", instance: "main", thread: "main" })
    })

    await Effect.runPromise(channel.provider.send(
      { provider: "telegram-support", chat: "-100123", topic: 42 },
      { type: "MessageReceived", id: "m1.reply", text: "fixed", at: 42 }
    ))

    expect(calls[0]?.url).toBe("https://telegram.test/bottoken/sendMessage")
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      chat_id: "-100123",
      text: "fixed",
      message_thread_id: 42
    })
  })

  test("refuses an invalid webhook secret at construction", () => {
    expect(() => telegram({
      name: "telegram-support",
      token: "token",
      secretToken: "contains spaces",
      target: () => ({ actor: "support", instance: "main", thread: "main" })
    })).toThrow()
  })
})
