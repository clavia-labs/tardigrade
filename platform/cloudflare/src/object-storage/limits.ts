import { SQL_OBJECT_CACHE_ROW_HEADROOM_BYTES } from "@clavia/tardigrade-agent"

// CLOUDFLARE_SQLITE_MAX_ROW_BYTES bounds a complete row (https://developers.cloudflare.com/durable-objects/platform/limits/).
export const CLOUDFLARE_SQLITE_MAX_ROW_BYTES = 2_000_000
export const CLOUDFLARE_SQLITE_MAX_OBJECT_BYTES = CLOUDFLARE_SQLITE_MAX_ROW_BYTES - SQL_OBJECT_CACHE_ROW_HEADROOM_BYTES
export const CLOUDFLARE_OBJECT_CACHE_CAPABILITIES = { maxObjectBytes: CLOUDFLARE_SQLITE_MAX_OBJECT_BYTES } as const
