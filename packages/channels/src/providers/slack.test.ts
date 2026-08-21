import { createHmac } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { WebhookRequest } from "@clavia/tardigrade-host/communication/webhook"
import { slack } from "./slack"

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

const signedRequest = (
  body: unknown,
  receivedAt = 1_700_000_000_000,
  secret = "signing-secret"
): WebhookRequest => {
  const bytes = encode(body)
  const timestamp = String(receivedAt / 1_000)
  const signature = `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:`)
    .update(bytes)
    .digest("hex")}`
  return {
    method: "POST",
    url: "https://example.test/webhooks/slack",
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature
    },
    body: bytes,
    receivedAt
  }
}

const options = () => ({
  name: "slack-support",
  botToken: "xoxb-token",
  signingSecret: "signing-secret",
  target: (source: { readonly channel: string; readonly thread: string }) => ({
    actor: "support",
    thread: `slack:${source.channel}:${source.thread}`
  })
})

describe("slack", () => {
  test("derives a linked actor delivery from a signed message event", async () => {
    const channel = slack(options())
    const payload = {
      type: "event_callback",
      team_id: "T123",
      event_id: "Ev123",
      event_time: 1_700_000_000,
      event: {
        type: "message",
        channel: "C123",
        user: "U123",
        text: "deploy failed",
        ts: "1700000000.000001",
        thread_ts: "1699999999.000001"
      }
    }

    const result = await Effect.runPromise(channel.webhook.receive(signedRequest(payload)))

    expect(result.deliveries[0]?.link).toEqual({
      source: {
        provider: "slack-support",
        team: "T123",
        channel: "C123",
        thread: "1699999999.000001",
        sender: "U123"
      },
      target: {
        actor: "support",
        thread: "slack:C123:1699999999.000001"
      }
    })
    expect(result.deliveries[0]?.event).toMatchObject({
      type: "MessageReceived",
      id: "slack:Ev123",
      text: "deploy failed",
      source: "slack-support",
      chat: "C123",
      sender: "U123"
    })
    expect(result.response).toEqual({ status: 200 })
  })

  test("answers a signed URL verification challenge", async () => {
    const channel = slack(options())

    const result = await Effect.runPromise(channel.webhook.receive(signedRequest({
      type: "url_verification",
      challenge: "prove-it"
    })))

    expect(new TextDecoder().decode(result.response.body)).toBe("prove-it")
    expect(result.deliveries).toEqual([])
  })

  test("rejects stale and incorrectly signed requests", async () => {
    const channel = slack(options())
    const stale = signedRequest({}, 1_700_000_000_000)
    const staleAtReceiver = { ...stale, receivedAt: stale.receivedAt + 301_000 }
    const wrong = signedRequest({}, 1_700_000_000_000, "wrong-secret")

    expect(await Effect.runPromise(channel.webhook.receive(staleAtReceiver))).toEqual({
      deliveries: [],
      response: { status: 401 }
    })
    expect(await Effect.runPromise(channel.webhook.receive(wrong))).toEqual({
      deliveries: [],
      response: { status: 401 }
    })
  })

  test("posts a reply to the persisted Slack thread", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = []
    const channel = slack({
      ...options(),
      apiBaseUrl: "https://slack.test/api/",
      fetch: async (input, init) => {
        calls.push({ url: String(input), ...(init === undefined ? {} : { init }) })
        return Response.json({ ok: true, channel: "C123", ts: "1700000001.000001" })
      }
    })

    await Effect.runPromise(channel.provider.send(
      {
        provider: "slack-support",
        team: "T123",
        channel: "C123",
        thread: "1699999999.000001"
      },
      { type: "MessageReceived", id: "m1.reply", text: "fixed", at: 42 }
    ))

    expect(calls[0]?.url).toBe("https://slack.test/api/chat.postMessage")
    expect(calls[0]?.init?.headers).toEqual({
      authorization: "Bearer xoxb-token",
      "content-type": "application/json; charset=utf-8"
    })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      channel: "C123",
      text: "fixed",
      thread_ts: "1699999999.000001"
    })
  })

  test("ignores bot messages to prevent reply loops", async () => {
    const channel = slack(options())
    const result = await Effect.runPromise(channel.webhook.receive(signedRequest({
      type: "event_callback",
      team_id: "T123",
      event_id: "EvBot",
      event: {
        type: "message",
        bot_id: "B123",
        channel: "C123",
        text: "fixed",
        ts: "1700000001.000001"
      }
    })))

    expect(result).toEqual({ deliveries: [], response: { status: 200 } })
  })
})
