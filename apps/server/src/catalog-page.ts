import type {
  ModelCatalog,
  ModelCatalogPage,
  ProviderCatalogPage
} from "@clavia/tardigrade-client/contract"
import { MODEL_PROVIDER_CONNECTIONS } from "@clavia/tardigrade-model/directory"

// DEFAULT_CATALOG_PAGE_LIMIT is the item count used when a catalog request states no limit.
export const DEFAULT_CATALOG_PAGE_LIMIT = 50

export interface CatalogPageQuery {
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
  readonly search?: string | undefined
}

export interface ModelCatalogPageQuery extends CatalogPageQuery {
  readonly provider?: string | undefined
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
    total: items.length,
    limit,
    ...(next < items.length ? { next_cursor: encoded({ revision: catalog.revision, offset: next, scope }) } : {}),
    items: selected
  }
}

export const providersPageOf = (
  catalog: ModelCatalog,
  query: CatalogPageQuery = {}
): ProviderCatalogPage => {
  const search = normalized(query.search)
  const discovered = new Map(catalog.providers.map((provider) => [provider.id, provider] as const))
  const ids = [...new Set([...discovered.keys(), ...MODEL_PROVIDER_CONNECTIONS.map((provider) => provider.id)])].sort()
  const items = ids.map((id) => {
    const provider = discovered.get(id)
    const connection = MODEL_PROVIDER_CONNECTIONS.find((candidate) => candidate.id === id)
    return {
      id,
      name: provider?.name ?? connection?.name ?? id,
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
  }).filter((provider) => search.length === 0 || `${provider.id} ${provider.name}`.toLocaleLowerCase().includes(search))
  return pageOf(catalog, items, query, `providers:${search}`)
}

export const modelsPageOf = (
  catalog: ModelCatalog,
  query: ModelCatalogPageQuery = {}
): ModelCatalogPage => {
  const providerFilter = normalized(query.provider)
  const search = normalized(query.search)
  const items = catalog.providers
    .filter((provider) => providerFilter.length === 0 || provider.id.toLocaleLowerCase() === providerFilter)
    .flatMap((provider) => provider.models.map((model) => ({ provider: provider.id, ...model })))
    .filter((model) => search.length === 0 || `${model.id} ${model.name ?? ""}`.toLocaleLowerCase().includes(search))
    .sort((left, right) => `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`))
  return pageOf(catalog, items, query, `models:${providerFilter}:${search}`)
}
