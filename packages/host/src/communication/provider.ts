import { Context, Effect } from "effect"
import type { ProviderAddress } from "@clavia/tardigrade-core/communication/address"
import { Outbound } from "@clavia/tardigrade-core/communication/outbound"
import type { MessageReceived } from "@clavia/tardigrade-core/communication/message"

// Provider sends normalized messages to source-specific coordinates owned by one configured provider instance.
export interface Provider<Source extends ProviderAddress = ProviderAddress> {
  readonly name: string
  send(target: Source, message: MessageReceived): Effect.Effect<void>
}

// outboundFrom selects providers by their configured names. Duplicate names throw at construction.
export const outboundFrom = (
  providers: ReadonlyArray<Provider>
): Context.Service.Shape<typeof Outbound> => {
  const byName = new Map<string, Provider>()
  for (const provider of providers) {
    if (byName.has(provider.name)) {
      throw new Error(`duplicate provider name: ${provider.name}`)
    }
    byName.set(provider.name, provider)
  }
  return {
    send: (link, message) => {
      const provider = byName.get(link.target.provider)
      return provider === undefined
        ? Effect.die(new Error(`provider unavailable: ${link.target.provider}`))
        : provider.send(link.target, message)
    }
  }
}

// unavailableOutbound rejects outbound work when a host has no configured providers.
export const unavailableOutbound: Context.Service.Shape<typeof Outbound> = outboundFrom([])
