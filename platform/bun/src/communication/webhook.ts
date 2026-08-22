import { Clock, Context, Data, Effect } from "effect"
import type { ProviderAddress } from "@clavia/tardigrade-core/communication/address"
import type { ActorUnavailable } from "@clavia/tardigrade-host/communication/ingress"
import { Ingress } from "@clavia/tardigrade-host/communication/ingress"
import type { Channel } from "@clavia/tardigrade-host/communication/channel"
import {
  handleWebhook,
  type Webhook,
  type WebhookRequest,
  type WebhookResponse
} from "@clavia/tardigrade-host/communication/webhook"

// WebhookRequestUnreadable reports a request whose raw HTTP body could not be captured.
export class WebhookRequestUnreadable extends Data.TaggedError("WebhookRequestUnreadable")<{
  readonly cause: unknown
}> {}

// webhookRequestFrom captures the HTTP values required for provider verification and translation.
export const webhookRequestFrom = (
  request: Request,
  receivedAt: number
): Effect.Effect<WebhookRequest, WebhookRequestUnreadable> =>
  Effect.tryPromise({
    try: async () => ({
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
      body: new Uint8Array(await request.arrayBuffer()),
      receivedAt
    }),
    catch: (cause) => new WebhookRequestUnreadable({ cause })
  })

// webhookResponseFrom creates the HTTP response returned to the provider.
export const webhookResponseFrom = (response: WebhookResponse): Response =>
  new Response(
    response.body,
    response.headers === undefined
      ? { status: response.status }
      : { status: response.status, headers: response.headers }
  )

// handleBunWebhook captures a request, accepts its deliveries, and returns the provider response.
export const handleBunWebhook = <R, E>(
  webhook: Webhook<R, E>,
  request: Request
): Effect.Effect<Response, E | ActorUnavailable | WebhookRequestUnreadable, R | Ingress> =>
  Effect.gen(function* () {
    const receivedAt = yield* Clock.currentTimeMillis
    const captured = yield* webhookRequestFrom(request, receivedAt)
    const response = yield* handleWebhook(webhook, captured)
    return webhookResponseFrom(response)
  })

// bunChannelHandler binds one environment-free channel and ingress service to a Bun HTTP handler.
export const bunChannelHandler = <Source extends ProviderAddress, E>(
  channel: Channel<Source, never, E>,
  ingress: Context.Service.Shape<typeof Ingress>
): ((request: Request) => Promise<Response>) =>
  (request) =>
    Effect.runPromise(
      handleBunWebhook(channel.webhook, request).pipe(
        Effect.provideService(Ingress, ingress)
      )
    )
