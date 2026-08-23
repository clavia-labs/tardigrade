import { Effect } from "effect"
import type { ProviderEndpoint } from "@clavia/tardigrade-core/communication/endpoint"
import type { ProviderEnvelope } from "@clavia/tardigrade-core/communication/envelope"
import type { MessageReceived } from "@clavia/tardigrade-core/communication/message"
import type { Transport } from "@clavia/tardigrade-core/communication/transport"

// Provider sends normalized messages to source-specific coordinates owned by one configured provider instance.
export interface Provider<Source extends ProviderEndpoint = ProviderEndpoint> {
  readonly name: string
  send(target: Source, message: MessageReceived): Effect.Effect<void>
}

// providerTransportFrom constructs the provider transport from configured provider instances. Duplicate names throw at construction.
export const providerTransportFrom = (
  providers: ReadonlyArray<Provider>
): Transport<ProviderEndpoint, ProviderEnvelope> => {
  const byName = new Map<string, Provider>()
  for (const provider of providers) {
    if (byName.has(provider.name)) {
      throw new Error(`duplicate provider name: ${provider.name}`)
    }
    byName.set(provider.name, provider)
  }
  return {
    name: "provider",
    send: (destination, envelope) => {
      const provider = byName.get(destination.provider)
      return provider === undefined
        ? Effect.die(new Error(`provider unavailable: ${destination.provider}`))
        : provider.send(destination, envelope.event)
    }
  }
}
