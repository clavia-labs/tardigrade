import type {
  CatalogAvailabilityFilter,
  ModelCatalog,
  ModelCatalogPage,
  ModelCatalogPriceSort,
  ModelCatalogSortOrder,
  ModelCatalogUnpricedOrder,
  ProviderCatalogPage
} from "@clavia/tardigrade-client/contract"
import { MODEL_PROVIDER_CONNECTIONS } from "@clavia/tardigrade-model/directory"
import { DEFAULT_MODEL_POLICY, modelAllowedBy, modelPolicyScopeOf, type ModelPolicy } from "tardie"
import {
  providerAvailabilityOf,
  type ProviderAvailabilities
} from "./catalog-availability"

// DEFAULT_CATALOG_PAGE_LIMIT is the item count used when a catalog request states no limit.
export const DEFAULT_CATALOG_PAGE_LIMIT = 50

// DEFAULT_MODEL_CATALOG_SORT_ORDER is the price order used when a model query states a sort field.
export const DEFAULT_MODEL_CATALOG_SORT_ORDER: ModelCatalogSortOrder = "asc"

// DEFAULT_MODEL_CATALOG_UNPRICED_ORDER places models without the selected rate after priced models.
export const DEFAULT_MODEL_CATALOG_UNPRICED_ORDER: ModelCatalogUnpricedOrder = "last"

// DEFAULT_CATALOG_AVAILABILITY_FILTER keeps the host catalog complete when a caller states no availability filter.
export const DEFAULT_CATALOG_AVAILABILITY_FILTER: CatalogAvailabilityFilter = "all"

export interface CatalogPageQuery {
  readonly availability?: CatalogAvailabilityFilter | undefined
  readonly models?: ModelPolicy | undefined
  readonly policy?: ModelPolicy | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
  readonly search?: string | undefined
}

export interface ModelCatalogPageQuery extends CatalogPageQuery {
  readonly provider?: string | undefined
  readonly sort?: ModelCatalogPriceSort | undefined
  readonly order?: ModelCatalogSortOrder | undefined
  readonly unpriced?: ModelCatalogUnpricedOrder | undefined
}

interface CatalogCursor {
  readonly revision: string
  readonly offset: number
  readonly scope: string
}

export class CatalogCursorError extends Error {}

const encoded = (value: CatalogCursor): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const decoded = (value: string): CatalogCursor => {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")
    const binary = atob(padded)
    const text = new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
    const cursor = JSON.parse(text) as Partial<CatalogCursor>
    if (typeof cursor.revision !== "string" || typeof cursor.offset !== "number" || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || typeof cursor.scope !== "string") {
      throw new Error("invalid cursor fields")
    }
    return cursor as CatalogCursor
  } catch {
    throw new CatalogCursorError("catalog cursor is invalid; restart from the first page")
  }
}

const normalized = (value: string | undefined): string => value?.trim().toLocaleLowerCase() ?? ""

const pageLimit = (limit: number | undefined): number => {
  const value = limit ?? DEFAULT_CATALOG_PAGE_LIMIT
  if (!Number.isSafeInteger(value) || value <= 0) throw new CatalogCursorError("catalog limit must be a positive integer")
  return value
}

const pageOffset = (catalog: ModelCatalog, query: CatalogPageQuery, scope: string): number => {
  if (query.cursor === undefined) return 0
  const cursor = decoded(query.cursor)
  if (cursor.revision !== catalog.revision) {
    throw new CatalogCursorError(`catalog cursor uses revision ${JSON.stringify(cursor.revision)}; restart at revision ${JSON.stringify(catalog.revision)}`)
  }
  if (cursor.scope !== scope) throw new CatalogCursorError("catalog cursor belongs to another query; restart from the first page")
  return cursor.offset
}

const pageOf = <A>(
  catalog: ModelCatalog,
  items: ReadonlyArray<A>,
  query: CatalogPageQuery,
  scope: string
) => {
  const limit = pageLimit(query.limit)
  const offset = pageOffset(catalog, query, scope)
  const selected = items.slice(offset, offset + limit)
  const next = offset + selected.length
  return {
    revision: catalog.revision,
    status: catalog.status,
    refreshed_at: catalog.refreshedAt,
    policy: query.policy ?? query.models ?? DEFAULT_MODEL_POLICY,
    total: items.length,
    limit,
    ...(next < items.length ? { next_cursor: encoded({ revision: catalog.revision, offset: next, scope }) } : {}),
    items: selected
  }
}

export const providersPageOf = (
  catalog: ModelCatalog,
  availability: ProviderAvailabilities,
  query: CatalogPageQuery = {}
): ProviderCatalogPage => {
  const availabilityFilter = query.availability ?? DEFAULT_CATALOG_AVAILABILITY_FILTER
  const search = normalized(query.search)
  const modelScope = query.models === undefined ? "wide" : modelPolicyScopeOf([query.models])
  const discovered = new Map(catalog.providers.map((provider) => [provider.id, provider] as const))
  const ids = [...new Set([
    ...discovered.keys(),
    ...MODEL_PROVIDER_CONNECTIONS.map((provider) => provider.id),
    ...Object.keys(availability)
  ])].sort()
  const items = ids.map((id) => {
    const provider = discovered.get(id)
    const connection = MODEL_PROVIDER_CONNECTIONS.find((candidate) => candidate.id === id)
    return {
      id,
      name: provider?.name ?? connection?.name ?? id,
      availability: providerAvailabilityOf(availability, id),
      ...(connection === undefined ? {} : { protocol: connection.protocol }),
      ...(connection?.baseUrl === undefined ? {} : { baseUrl: connection.baseUrl }),
      env: provider?.env ?? [],
      required: [
        ...(connection?.baseUrl === undefined ? ["baseUrl"] : []),
        ...(connection === undefined ? ["protocol"] : []),
        "env",
        ...(connection?.region === true ? ["region"] : [])
      ],
      optional: connection?.baseUrl === undefined ? [] : ["baseUrl"]
    }
  }).filter((provider) => {
    if (query.models === undefined || query.models.allow === "*") return true
    return discovered.get(provider.id)?.models.some((model) =>
      modelAllowedBy(query.models!, { provider: provider.id, model_id: model.id })
    ) === true
  }).filter((provider) => availabilityFilter === "all" || provider.availability.status === "available")
    .filter((provider) => search.length === 0 || `${provider.id} ${provider.name}`.toLocaleLowerCase().includes(search))
  return pageOf(catalog, items, query, `providers:${availabilityFilter}:${search}:${modelScope}`)
}

export const modelsPageOf = (
  catalog: ModelCatalog,
  availability: ProviderAvailabilities,
  query: ModelCatalogPageQuery = {}
): ModelCatalogPage => {
  const availabilityFilter = query.availability ?? DEFAULT_CATALOG_AVAILABILITY_FILTER
  const providerFilter = normalized(query.provider)
  const search = normalized(query.search)
  const modelScope = query.models === undefined ? "wide" : modelPolicyScopeOf([query.models])
  const sort = query.sort
  const order = query.order ?? DEFAULT_MODEL_CATALOG_SORT_ORDER
  const unpriced = query.unpriced ?? DEFAULT_MODEL_CATALOG_UNPRICED_ORDER
  const identity = (model: { readonly provider: string; readonly id: string }): string => `${model.provider}/${model.id}`
  const items = catalog.providers
    .filter((provider) => availabilityFilter === "all" || providerAvailabilityOf(availability, provider.id).status === "available")
    .filter((provider) => providerFilter.length === 0 || provider.id.toLocaleLowerCase() === providerFilter)
    .flatMap((provider) => provider.models.map((model) => ({ provider: provider.id, ...model })))
    .filter((model) => query.models === undefined || modelAllowedBy(query.models, { provider: model.provider, model_id: model.id }))
    .filter((model) => search.length === 0 || `${model.id} ${model.name ?? ""}`.toLocaleLowerCase().includes(search))
    .sort((left, right) => {
      if (sort === undefined) return identity(left).localeCompare(identity(right))
      const leftRate = left.metadata.pricing?.[sort]
      const rightRate = right.metadata.pricing?.[sort]
      if (leftRate === undefined && rightRate !== undefined) return unpriced === "first" ? -1 : 1
      if (leftRate !== undefined && rightRate === undefined) return unpriced === "first" ? 1 : -1
      if (leftRate !== undefined && rightRate !== undefined && leftRate !== rightRate) {
        return order === "asc" ? leftRate - rightRate : rightRate - leftRate
      }
      return identity(left).localeCompare(identity(right))
    })
  return pageOf(catalog, items, query, `models:${availabilityFilter}:${providerFilter}:${search}:${sort ?? "identity"}:${order}:${unpriced}:${modelScope}`)
}
