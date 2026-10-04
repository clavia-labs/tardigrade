import { CLOUDFLARE_SQLITE_MAX_ROW_BYTES } from "@clavia/tardigrade-cloudflare/limits"
import { CHECKPOINT_CHUNK_ROW_OVERHEAD_BYTES } from "../shared/checkpoint-chunks"
export { CLOUDFLARE_SQLITE_MAX_ROW_BYTES } from "@clavia/tardigrade-cloudflare/limits"

export const CLOUDFLARE_SQL_LIMITS = Object.freeze({ maxRowBytes: CLOUDFLARE_SQLITE_MAX_ROW_BYTES })
export const CLOUDFLARE_MAX_CHECKPOINT_CHUNK_BYTES = CLOUDFLARE_SQLITE_MAX_ROW_BYTES - CHECKPOINT_CHUNK_ROW_OVERHEAD_BYTES
