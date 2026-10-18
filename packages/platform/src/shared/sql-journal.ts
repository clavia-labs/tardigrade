export { synchronousJournal } from "./synchronous-journal"
export { DEFAULT_CHECKPOINT_COLLECT_EVERY, DEFAULT_CHECKPOINT_SCHEDULER, type CheckpointTreeOptions } from "./storage-policy"
export { DEFAULT_EVENT_INLINE_BYTES, type JournalRecordOptions, type SqlJournalLimits } from "./journal-records"
export { DEFAULT_CHECKPOINT_CHUNK_BYTES, type CheckpointChunkOptions } from "./checkpoint-chunks"
import type { Recorded } from "@clavia/tardigrade-core"
import { decodeCheckpointChunks, type CheckpointChunk } from "./checkpoint-chunks"

// decodeSqlJournalRecord reconstructs a logical record for journal readers and storage exporters (journalEventChunks).
export function decodeSqlJournalRecord<Event extends object>(text: string, chunks: readonly CheckpointChunk[] | (() => readonly CheckpointChunk[]) = []): Recorded<Event> {
  const stored = JSON.parse(text) as Recorded<Event> | { chunkCount: number; byteLength: number }
  if (!("chunkCount" in stored)) return stored
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeCheckpointChunks(typeof chunks === "function" ? chunks() : chunks, stored.byteLength, stored.chunkCount))) as Recorded<Event>
}
