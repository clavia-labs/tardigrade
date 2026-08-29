import { createHmac, timingSafeEqual } from "node:crypto"
import { Effect } from "effect"
import type { ThreadAddress, ProviderEndpoint } from "@clavia/tardigrade-core/communication/endpoint"
import type { MessageReceived } from "@clavia/tardigrade-core/communication/message"
import {
  channelOf,
  type Channel,
  type ChannelProvider,
  type ProviderReceipt
} from "@clavia/tardigrade-host/communication/channel"

export const SLACK_API_BASE_URL = "https://slack.com/api"
export const SLACK_SIGNATURE_HEADER = "x-slack-signature"
export const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp"
export const DEFAULT_SLACK_SIGNATURE_TOLERANCE_SECONDS = 300

type SlackFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

// SlackEndpoint identifies one Slack thread under a configured provider instance.
export interface SlackEndpoint extends ProviderEndpoint {
  readonly team: string
  readonly channel: string
  readonly thread: string
  readonly sender?: string
}

// SlackOptions configures one Slack app connection and its actor binding.
export interface SlackOptions {
  readonly name: string
  readonly botToken: string
  readonly signingSecret: string
  readonly target: (source: SlackEndpoint) => ThreadAddress
  readonly method?: string
  readonly apiBaseUrl?: string
  readonly fetch?: SlackFetch
  readonly signatureToleranceSeconds?: number
}

interface SlackEnvelope {
  readonly type?: unknown
  readonly challenge?: unknown
  readonly team_id?: unknown
  readonly event_id?: unknown
  readonly event_time?: unknown
  readonly event?: {
    readonly type?: unknown
    readonly subtype?: unknown
    readonly bot_id?: unknown
    readonly channel?: unknown
    readonly user?: unknown
    readonly text?: unknown
    readonly ts?: unknown
    readonly thread_ts?: unknown
  }
}

const emptyReceipt = (status: number): ProviderReceipt<SlackEndpoint> => ({
  inbound: [],
  response: { status }
})

const textResponse = (status: number, body: string): ProviderReceipt<SlackEndpoint> => ({
  inbound: [],
  response: {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: new TextEncoder().encode(body)
  }
})

const isSlackEndpoint = (address: ProviderEndpoint): address is SlackEndpoint =>
  "team" in address && typeof address.team === "string" &&
  "channel" in address && typeof address.channel === "string" &&
  "thread" in address && typeof address.thread === "string"

const signatureOf = (secret: string, timestamp: string, body: Uint8Array): string =>
  `v0=${createHmac("sha256", secret)
    .update("v0:")
    .update(timestamp)
    .update(":")
    .update(body)
    .digest("hex")}`

const signaturesEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

const verified = (
  options: SlackOptions,
  timestamp: string | undefined,
  signature: string | undefined,
  body: Uint8Array,
  receivedAt: number
): boolean => {
  if (timestamp === undefined || signature === undefined) return false
  const seconds = Number(timestamp)
  if (!Number.isSafeInteger(seconds)) return false
  const tolerance = options.signatureToleranceSeconds ?? DEFAULT_SLACK_SIGNATURE_TOLERANCE_SECONDS
  if (Math.abs(receivedAt / 1_000 - seconds) > tolerance) return false
  return signaturesEqual(signatureOf(options.signingSecret, timestamp, body), signature)
}

const parseEnvelope = (
  options: SlackOptions,
  body: Uint8Array,
  receivedAt: number
): ProviderReceipt<SlackEndpoint> => {
  let envelope: SlackEnvelope
  try {
    envelope = JSON.parse(new TextDecoder().decode(body)) as SlackEnvelope
  } catch {
    return emptyReceipt(400)
  }
  if (envelope.type === "url_verification" && typeof envelope.challenge === "string") {
    return textResponse(200, envelope.challenge)
  }
  const event = envelope.event
  if (
    envelope.type !== "event_callback" ||
    typeof envelope.team_id !== "string" ||
    typeof envelope.event_id !== "string" ||
    event?.type !== "message" ||
    event.subtype !== undefined ||
    event.bot_id !== undefined ||
    typeof event.channel !== "string" ||
    typeof event.text !== "string" ||
    typeof event.ts !== "string"
  ) {
    return emptyReceipt(200)
  }
  const source: SlackEndpoint = {
    provider: options.name,
    team: envelope.team_id,
    channel: event.channel,
    thread: typeof event.thread_ts === "string" ? event.thread_ts : event.ts,
    ...(typeof event.user === "string" ? { sender: event.user } : {})
  }
  const eventAt = Number(event.ts) * 1_000
  const at = Number.isFinite(eventAt)
    ? eventAt
    : typeof envelope.event_time === "number"
      ? envelope.event_time * 1_000
      : receivedAt
  const message: MessageReceived = {
    type: "MessageReceived",
    id: `slack:${envelope.event_id}`,
    text: event.text,
    source: options.name,
    chat: event.channel,
    ...(source.sender === undefined ? {} : { sender: source.sender }),
    data: envelope,
    at
  }
  return { inbound: [{ source, event: message }], response: { status: 200 } }
}

const providerOf = (options: SlackOptions): ChannelProvider<SlackEndpoint> => {
  const fetch = options.fetch ?? globalThis.fetch
  const apiBaseUrl = (options.apiBaseUrl ?? SLACK_API_BASE_URL).replace(/\/$/, "")
  return {
    name: options.name,
    receive: (request) => {
      if (request.method !== "POST") return Effect.succeed(emptyReceipt(405))
      if (!verified(
        options,
        request.headers[SLACK_TIMESTAMP_HEADER],
        request.headers[SLACK_SIGNATURE_HEADER],
        request.body,
        request.receivedAt
      )) {
        return Effect.succeed(emptyReceipt(401))
      }
      return Effect.succeed(parseEnvelope(options, request.body, request.receivedAt))
    },
    send: (target, message) => {
      if (target.provider !== options.name || !isSlackEndpoint(target)) {
        return Effect.die(new Error(`invalid address for provider: ${options.name}`))
      }
      return Effect.promise(async () => {
        const result = await fetch(`${apiBaseUrl}/chat.postMessage`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.botToken}`,
            "content-type": "application/json; charset=utf-8"
          },
          body: JSON.stringify({
            channel: target.channel,
            text: message.text,
            thread_ts: target.thread
          })
        })
        const body = await result.json() as { readonly ok?: unknown; readonly error?: unknown }
        if (!result.ok || body.ok !== true) {
          throw new Error(
            typeof body.error === "string"
              ? `Slack chat.postMessage failed: ${body.error}`
              : `Slack chat.postMessage failed with status ${result.status}`
          )
        }
      })
    }
  }
}

// slack constructs a bidirectional channel whose source address preserves the Slack reply thread.
export const DEFAULT_SLACK_METHOD = "message"

export const slack = (options: SlackOptions): Channel<SlackEndpoint> => {
  if (options.name.length === 0) throw new Error("Slack provider name cannot be empty")
  if (options.botToken.length === 0) throw new Error("Slack bot token cannot be empty")
  if (options.signingSecret.length === 0) throw new Error("Slack signing secret cannot be empty")
  const tolerance = options.signatureToleranceSeconds ?? DEFAULT_SLACK_SIGNATURE_TOLERANCE_SECONDS
  if (!Number.isSafeInteger(tolerance) || tolerance < 0) {
    throw new Error("Slack signature tolerance must be a non-negative integer")
  }
  return channelOf(providerOf(options), options.target, { method: options.method ?? DEFAULT_SLACK_METHOD })
}
