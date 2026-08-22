import { Effect } from "effect"
import type { ActorAddress, ProviderAddress } from "@clavia/tardigrade-core/communication/address"
import { deliveryOf } from "@clavia/tardigrade-core/communication/delivery"
import { linkOf } from "@clavia/tardigrade-core/communication/link"
import type { MessageReceived } from "@clavia/tardigrade-core/communication/message"
import type { Provider } from "./provider"
import type { Webhook, WebhookRequest, WebhookResponse } from "./webhook"

// ProviderInbound pairs one normalized message with the source coordinates required for a later reply.
export interface ProviderInbound<Source extends ProviderAddress> {
  readonly source: Source
  readonly event: MessageReceived
}

// ProviderReceipt carries verified inbound messages and the acknowledgement owed to the provider.
export interface ProviderReceipt<Source extends ProviderAddress> {
  readonly inbound: ReadonlyArray<ProviderInbound<Source>>
  readonly response: WebhookResponse
}

// ChannelProvider owns inbound verification and parsing together with outbound delivery for one provider instance.
export interface ChannelProvider<Source extends ProviderAddress, R = never, E = never> extends Provider<Source> {
  readonly receive: (request: WebhookRequest) => Effect.Effect<ProviderReceipt<Source>, E, R>
}

// Channel binds source-specific provider traffic to actor addresses in both directions.
export interface Channel<Source extends ProviderAddress, R = never, E = never> {
  readonly provider: ChannelProvider<Source, R, E>
  readonly webhook: Webhook<R, E>
}

// channelOf adapts a provider into ingress deliveries using the application's source-to-actor binding.
export const channelOf = <Source extends ProviderAddress, R = never, E = never>(
  provider: ChannelProvider<Source, R, E>,
  target: (source: Source) => ActorAddress
): Channel<Source, R, E> => ({
  provider,
  webhook: {
    name: provider.name,
    receive: (request) =>
      provider.receive(request).pipe(
        Effect.map((receipt) => ({
          deliveries: receipt.inbound.map((inbound) =>
            deliveryOf(linkOf(inbound.source, target(inbound.source)), inbound.event)
          ),
          response: receipt.response
        }))
      )
  }
})
