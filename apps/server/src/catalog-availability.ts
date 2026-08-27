import type { ProviderAvailability } from "@clavia/tardigrade-client/contract"

import type { ModelConfig, ModelCredentials } from "./config"

// ProviderAvailabilities records whether each declared provider connection has a usable credential.
export type ProviderAvailabilities = Readonly<Record<string, ProviderAvailability>>

// providerAvailabilitiesOf derives public readiness without exposing credential values.
export const providerAvailabilitiesOf = (
  config: ModelConfig,
  credentials: ModelCredentials
): ProviderAvailabilities => Object.fromEntries(
  Object.entries(config.providers).map(([id, provider]) => [
    id,
    provider.env.some((name) => credentials[name] !== undefined)
      ? { status: "available" as const }
      : { status: "unavailable" as const, reason: "credential_missing" as const }
  ])
)

// providerAvailabilityOf resolves providers absent from host configuration as unavailable.
export const providerAvailabilityOf = (
  providers: ProviderAvailabilities,
  id: string
): ProviderAvailability => providers[id] ?? { status: "unavailable", reason: "not_configured" }
