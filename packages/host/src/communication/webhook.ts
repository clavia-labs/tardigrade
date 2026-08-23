import { Effect } from "effect"
import type { ActorEnvelope } from "@clavia/tardigrade-core/communication/envelope"
import type { MessageReceived } from "@clavia/tardigrade-core/communication/message"
import { Ingress, type ActorUnavailable } from "./ingress"

// WebhookRequest is the transport-neutral input captured from one HTTP request. Headers use lowercase names, body keeps the original bytes, and receivedAt is the host's acceptance time.
export interface WebhookRequest {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
  readonly receivedAt: number
}

// WebhookResponse is the HTTP value a transport sends after ingress accepts the derived envelopes.
export interface WebhookResponse {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: Uint8Array
}

// WebhookResult pairs the provider response with every durable delivery derived from the request.
export interface WebhookResult {
  readonly envelopes: ReadonlyArray<ActorEnvelope<MessageReceived>>
  readonly response: WebhookResponse
}

// Webhook verifies and translates one captured provider request. Expected provider refusals and challenges return no envelopes.
export interface Webhook<R = never, E = never> {
  readonly name: string
  readonly receive: (request: WebhookRequest) => Effect.Effect<WebhookResult, E, R>
}

// handleWebhook returns the provider response after ingress commits every delivery and schedules each affected actor.
export const handleWebhook = <R, E>(
  webhook: Webhook<R, E>,
  request: WebhookRequest
): Effect.Effect<WebhookResponse, E | ActorUnavailable, R | Ingress> =>
  Effect.gen(function* () {
    const result = yield* webhook.receive(request)
    const ingress = yield* Ingress
    yield* ingress.commit(result.envelopes)
    yield* ingress.schedule(result.envelopes)
    return result.response
  })
