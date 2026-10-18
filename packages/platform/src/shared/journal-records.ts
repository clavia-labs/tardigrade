// DEFAULT_EVENT_INLINE_BYTES bounds inline UTF-8 journal records before chunking (test/properties/journal-event-chunks.ts).
export const DEFAULT_EVENT_INLINE_BYTES = 1_500_000
export interface JournalRecordOptions { readonly eventInlineBytes?: number | undefined }
export interface SqlJournalLimits { readonly maxRowBytes: number }
