// CloudflareErrorClassification describes failure evidence independently of replay safety.
export interface CloudflareErrorClassification {
  readonly classification: "transient" | "permanent" | "unknown"
  readonly code?: string | number
  readonly status?: number
  readonly retryAfterMillis?: number
}
