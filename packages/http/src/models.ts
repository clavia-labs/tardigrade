import { Context, Effect } from "effect"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { InvalidRequest, ModelCatalogUnavailable, modelsGroup, RequestProblems } from "@clavia/tardigrade-client/contract"
import type { ModelConfig, ModelCredentials } from "@clavia/tardigrade-model/config"
import type { ModelCatalogState } from "@clavia/tardigrade-model/catalog"
import { providerAvailabilitiesOf } from "@clavia/tardigrade-model/catalog/availability"
import { modelsPageOf, providersPageOf } from "@clavia/tardigrade-model/catalog/page"

// CatalogDiscovery supplies a public snapshot with the host's provider availability and model policy.
export class CatalogDiscovery extends Context.Service<CatalogDiscovery, {
  readonly read: Effect.Effect<ModelCatalogState & {
    readonly availability: ReturnType<typeof providerAvailabilitiesOf>
    readonly policy: Pick<ModelConfig, "allow" | "default">
  }>
}>()("tardigrade/http/CatalogDiscovery") {}

// catalogDiscoveryOf exposes catalog policy and readiness without exposing credentials (apps/server/src/api.test.ts).
export const catalogDiscoveryOf = (catalog: ModelCatalogState, model: ModelConfig, credentials: ModelCredentials): typeof CatalogDiscovery.Service => ({
  read: Effect.succeed({ ...catalog, availability: providerAvailabilitiesOf(model, credentials), policy: model })
})

export const CatalogApi = HttpApi.make("tardigrade").add(modelsGroup).middleware(RequestProblems)

const discovery = <R>(source: Effect.Effect<typeof CatalogDiscovery.Service | undefined, never, R>) => Effect.flatMap(source, (service) => service === undefined
  ? Effect.fail(ModelCatalogUnavailable.of("No model catalog is supplied by this server."))
  : service.read).pipe(
  Effect.flatMap(({ snapshot, availability, policy }) => snapshot === undefined
    ? Effect.fail(ModelCatalogUnavailable.of("No validated model catalog is available. Check the catalog configuration."))
    : Effect.succeed({ catalog: snapshot, availability, policy }))
)

// catalogHandlers pages the public snapshot without exposing provider credentials.
export const catalogHandlers = <R>(source: Effect.Effect<typeof CatalogDiscovery.Service | undefined, never, R>) => HttpApiBuilder.group(CatalogApi, "models", (handlers) => handlers
  .handle("providers", ({ query }) => Effect.flatMap(discovery(source), ({ catalog, availability, policy }) =>
    Effect.try({
      try: () => providersPageOf(catalog, availability, { ...query, policy }),
      catch: (error) => InvalidRequest.of(error instanceof Error ? error.message : String(error))
    })))
  .handle("models", ({ query }) => Effect.flatMap(discovery(source), ({ catalog, availability, policy }) =>
    Effect.try({
      try: () => modelsPageOf(catalog, availability, { ...query, policy }),
      catch: (error) => InvalidRequest.of(error instanceof Error ? error.message : String(error))
    }))))

export const layerCatalogHandlers = catalogHandlers(CatalogDiscovery)
