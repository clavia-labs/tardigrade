import { Schema } from "effect"

const ModelCatalogRate = Schema.Finite.pipe(
  Schema.check(Schema.makeFilter((value: number) => value >= 0, { title: "non-negative" }))
)

const ModelTokenCount = Schema.Int.pipe(
  Schema.check(Schema.makeFilter((value: number) => value > 0, { title: "positive" }))
)

export const ModelCatalogPricing = Schema.Struct({
  promptUsdPerToken: ModelCatalogRate,
  completionUsdPerToken: ModelCatalogRate,
  cachedPromptUsdPerToken: Schema.optionalKey(ModelCatalogRate),
  cacheWritePromptUsdPerToken: Schema.optionalKey(ModelCatalogRate)
}).annotate({ identifier: "ModelCatalogPricing" })

export const ModelCatalogMetadata = Schema.Struct({
  contextWindowTokens: Schema.optionalKey(ModelTokenCount),
  maxOutputTokens: Schema.optionalKey(ModelTokenCount),
  pricing: Schema.optionalKey(ModelCatalogPricing),
  toolCall: Schema.optionalKey(Schema.Boolean),
  structuredOutput: Schema.optionalKey(Schema.Boolean),
  inputModalities: Schema.optionalKey(Schema.Array(Schema.String)),
  outputModalities: Schema.optionalKey(Schema.Array(Schema.String))
}).annotate({ identifier: "ModelCatalogMetadata" })

export const ModelCatalogModel = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.optionalKey(Schema.String),
  metadata: ModelCatalogMetadata
}).annotate({ identifier: "ModelCatalogModel" })

export const ModelCatalogProvider = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  api: Schema.optionalKey(Schema.String),
  npm: Schema.optionalKey(Schema.String),
  env: Schema.Array(Schema.String),
  models: Schema.Array(ModelCatalogModel)
}).annotate({ identifier: "ModelCatalogProvider" })

// ModelCatalog describes the public provider and model snapshot.
export const ModelCatalog = Schema.Struct({
  source: Schema.Literal("models.dev"),
  revision: Schema.NonEmptyString,
  refreshedAt: Schema.Finite,
  status: Schema.Literals(["fresh", "cached"]),
  providers: Schema.Array(ModelCatalogProvider)
}).annotate({ identifier: "ModelCatalog" })

export type ModelCatalog = typeof ModelCatalog.Type

export const ModelPolicySummary = Schema.Struct({
  default: Schema.optionalKey(Schema.Struct({
    provider: Schema.NonEmptyString,
    model_id: Schema.NonEmptyString
  })),
  allow: Schema.Union([
    Schema.Literal("*"),
    Schema.Array(Schema.Struct({
      provider: Schema.NonEmptyString,
      model_ids: Schema.Union([Schema.Literal("*"), Schema.Array(Schema.NonEmptyString)])
    }))
  ])
}).annotate({ identifier: "ModelPolicySummary" })

export type ModelPolicySummary = typeof ModelPolicySummary.Type

const CatalogPageFields = {
  revision: Schema.NonEmptyString,
  status: Schema.Literals(["fresh", "cached"]),
  refreshed_at: Schema.Finite,
  policy: ModelPolicySummary,
  total: Schema.Int,
  limit: Schema.Int,
  next_cursor: Schema.optionalKey(Schema.String)
}

export const ProviderAvailability = Schema.Union([
  Schema.Struct({ status: Schema.Literal("available") }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals(["not_configured", "credential_missing"])
  })
]).annotate({ identifier: "ProviderAvailability" })

export type ProviderAvailability = typeof ProviderAvailability.Type

export const CATALOG_AVAILABILITY_FILTERS = ["all", "available"] as const
export type CatalogAvailabilityFilter = typeof CATALOG_AVAILABILITY_FILTERS[number]

export const ProviderCatalogItem = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  availability: ProviderAvailability,
  protocol: Schema.optionalKey(Schema.String),
  baseUrl: Schema.optionalKey(Schema.String),
  env: Schema.Array(Schema.String),
  required: Schema.Array(Schema.String),
  optional: Schema.Array(Schema.String)
}).annotate({ identifier: "ProviderCatalogItem" })

export const ProviderCatalogPage = Schema.Struct({
  ...CatalogPageFields,
  items: Schema.Array(ProviderCatalogItem)
}).annotate({ identifier: "ProviderCatalogPage" })

export type ProviderCatalogPage = typeof ProviderCatalogPage.Type

export const ModelCatalogItem = Schema.Struct({
  provider: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
  name: Schema.optionalKey(Schema.String),
  metadata: ModelCatalogMetadata
}).annotate({ identifier: "ModelCatalogItem" })

export const ModelCatalogPage = Schema.Struct({
  ...CatalogPageFields,
  items: Schema.Array(ModelCatalogItem)
}).annotate({ identifier: "ModelCatalogPage" })

export type ModelCatalogPage = typeof ModelCatalogPage.Type

export const MODEL_CATALOG_PRICE_SORTS = [
  "promptUsdPerToken",
  "completionUsdPerToken",
  "cachedPromptUsdPerToken",
  "cacheWritePromptUsdPerToken"
] as const

export type ModelCatalogPriceSort = typeof MODEL_CATALOG_PRICE_SORTS[number]

export const MODEL_CATALOG_SORT_ORDERS = ["asc", "desc"] as const
export type ModelCatalogSortOrder = typeof MODEL_CATALOG_SORT_ORDERS[number]

export const MODEL_CATALOG_UNPRICED_ORDERS = ["first", "last"] as const
export type ModelCatalogUnpricedOrder = typeof MODEL_CATALOG_UNPRICED_ORDERS[number]
