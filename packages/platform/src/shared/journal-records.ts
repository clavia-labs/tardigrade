// DEFAULT_EVENT_INLINE_BYTES bounds inline UTF-8 journal records before chunking (test/properties/journal-event-chunks.ts).
export const DEFAULT_EVENT_INLINE_BYTES = 1_500_000
export interface JournalRecordOptions { readonly eventInlineBytes?: number | undefined }
export interface SqlJournalLimits { readonly maxRowBytes: number }

import type { Recorded } from "@clavia/tardigrade-core"
import { decodeCheckpointChunks } from "./checkpoint-chunks"

// decodeSqlJournalRecord reads the 0.50 inline and chunked event encoding (test/properties/journal-event-chunks.ts; test/properties/event-log-compatibility.ts).
export function decodeSqlJournalRecord<Event extends object>(text: string, chunks: readonly { readonly ordinal: number; readonly payload: Uint8Array | ArrayBuffer }[] | (() => readonly { readonly ordinal: number; readonly payload: Uint8Array | ArrayBuffer }[]) = []): Recorded<Event> {
  const stored = JSON.parse(text) as Recorded<Event> | { chunkCount: number; byteLength: number }
  if (!("chunkCount" in stored)) return stored
  const rows = typeof chunks === "function" ? chunks() : chunks
  const payload = decodeCheckpointChunks(rows.map(row => ({ ordinal: row.ordinal, payload: row.payload instanceof Uint8Array ? row.payload : new Uint8Array(row.payload) })), stored.byteLength, stored.chunkCount)
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as Recorded<Event>
}
