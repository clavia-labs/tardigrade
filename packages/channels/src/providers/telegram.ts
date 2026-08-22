import { Effect } from "effect"
import type { ActorAddress, ProviderAddress } from "@clavia/tardigrade-core/communication/address"
import type { MessageReceived } from "@clavia/tardigrade-core/communication/message"
import {
  channelOf,
  type Channel,
  type ChannelProvider,
  type ProviderReceipt
} from "@clavia/tardigrade-host/communication/channel"

export const TELEGRAM_API_BASE_URL = "https://api.telegram.org"
export const TELEGRAM_SECRET_TOKEN_HEADER = "x-telegram-bot-api-secret-token"

const SECRET_TOKEN = /^[A-Za-z0-9_-]{1,256}$/
type TelegramFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

// TelegramAddress identifies one chat and optional forum topic under a configured Telegram provider.
export interface TelegramAddress extends ProviderAddress {
  readonly chat: string
  readonly topic?: number
  readonly sender?: string
}

// TelegramOptions configures one Telegram bot connection and its actor binding.
export interface TelegramOptions {
  readonly name: string
  readonly token: string
  readonly secretToken: string
  readonly target: (source: TelegramAddress) => ActorAddress
  readonly apiBaseUrl?: string
  readonly fetch?: TelegramFetch
}

interface TelegramUpdate {
  readonly update_id?: unknown
  readonly message?: {
    readonly message_id?: unknown
    readonly message_thread_id?: unknown
    readonly date?: unknown
    readonly text?: unknown
    readonly from?: { readonly id?: unknown }
    readonly chat?: { readonly id?: unknown }
  }
}

const constantTimeEqual = (left: string, right: string): boolean => {
  const a = new TextEncoder().encode(left)
  const b = new TextEncoder().encode(right)
  const length = Math.max(a.length, b.length)
  let difference = a.length ^ b.length
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0)
  }
  return difference === 0
}

const response = (status: number): ProviderReceipt<TelegramAddress> => ({
  inbound: [],
  response: { status }
})

const isTelegramAddress = (address: ProviderAddress): address is TelegramAddress =>
  "chat" in address &&
  typeof address.chat === "string" &&
  (!("topic" in address) || address.topic === undefined || typeof address.topic === "number")

const parseUpdate = (
  options: TelegramOptions,
  body: Uint8Array,
  receivedAt: number
): ProviderReceipt<TelegramAddress> => {
  let update: TelegramUpdate
  try {
    update = JSON.parse(new TextDecoder().decode(body)) as TelegramUpdate
  } catch {
    return response(400)
  }
  const message = update.message
  if (
    typeof update.update_id !== "number" ||
    message === undefined ||
    typeof message.message_id !== "number" ||
    typeof message.text !== "string" ||
    (typeof message.chat?.id !== "number" && typeof message.chat?.id !== "string")
  ) {
    return response(200)
  }
  const source: TelegramAddress = {
    provider: options.name,
    chat: String(message.chat.id),
    ...(typeof message.message_thread_id === "number" ? { topic: message.message_thread_id } : {}),
    ...(typeof message.from?.id === "number" || typeof message.from?.id === "string"
      ? { sender: String(message.from.id) }
      : {})
  }
  const at = typeof message.date === "number" ? message.date * 1_000 : receivedAt
  const event: MessageReceived = {
    type: "MessageReceived",
    id: `telegram:${update.update_id}`,
    text: message.text,
    source: options.name,
    chat: source.chat,
    ...(source.sender === undefined ? {} : { sender: source.sender }),
    data: update,
    at
  }
  return { inbound: [{ source, event }], response: { status: 200 } }
}

const providerOf = (options: TelegramOptions): ChannelProvider<TelegramAddress> => {
  const fetch = options.fetch ?? globalThis.fetch
  const apiBaseUrl = (options.apiBaseUrl ?? TELEGRAM_API_BASE_URL).replace(/\/$/, "")
  return {
    name: options.name,
    receive: (request) => {
      if (request.method !== "POST") return Effect.succeed(response(405))
      const supplied = request.headers[TELEGRAM_SECRET_TOKEN_HEADER]
      if (supplied === undefined || !constantTimeEqual(supplied, options.secretToken)) {
        return Effect.succeed(response(401))
      }
      return Effect.succeed(parseUpdate(options, request.body, request.receivedAt))
    },
    send: (target, message) => {
      if (target.provider !== options.name || !isTelegramAddress(target)) {
        return Effect.die(new Error(`invalid address for provider: ${options.name}`))
      }
      return Effect.promise(async () => {
        const result = await fetch(`${apiBaseUrl}/bot${options.token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: target.chat,
            text: message.text,
            ...(target.topic === undefined ? {} : { message_thread_id: target.topic })
          })
        })
        const body = await result.json() as { readonly ok?: unknown; readonly description?: unknown }
        if (!result.ok || body.ok !== true) {
          throw new Error(
            typeof body.description === "string"
              ? `Telegram sendMessage failed: ${body.description}`
              : `Telegram sendMessage failed with status ${result.status}`
          )
        }
      })
    }
  }
}

// telegram constructs a bidirectional channel whose persisted source address is sufficient for later replies.
export const telegram = (options: TelegramOptions): Channel<TelegramAddress> => {
  if (options.name.length === 0) throw new Error("Telegram provider name cannot be empty")
  if (options.token.length === 0) throw new Error("Telegram bot token cannot be empty")
  if (!SECRET_TOKEN.test(options.secretToken)) {
    throw new Error("Telegram webhook secret token must contain 1 to 256 letters, digits, underscores, or hyphens")
  }
  return channelOf(providerOf(options), options.target)
}
