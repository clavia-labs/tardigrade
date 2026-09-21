import { Duration, Effect } from "effect"
import { DEFAULT_EVENT_LIMIT, DEFAULT_SSE_HEARTBEAT, DEFAULT_INFERENCE_STREAM_BUFFER_CAPACITY } from "@clavia/tardigrade-http/sse"

export interface CloudflareStreamPolicy {
  readonly heartbeatMillis: number
  readonly pageSize: number
  readonly inferenceBufferCapacity: number
}

export const DEFAULT_CLOUDFLARE_STREAM_POLICY: CloudflareStreamPolicy = {
  heartbeatMillis: Duration.toMillis(DEFAULT_SSE_HEARTBEAT),
  pageSize: DEFAULT_EVENT_LIMIT,
  inferenceBufferCapacity: DEFAULT_INFERENCE_STREAM_BUFFER_CAPACITY
}

export const streamPolicyOf = (options: Partial<CloudflareStreamPolicy> = {}): CloudflareStreamPolicy => {
  const policy = { ...DEFAULT_CLOUDFLARE_STREAM_POLICY, ...options }
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`stream ${name} must be a positive integer`)
  }
  return policy
}

export class CommitSignal {
  private head = 0
  private readonly listeners = new Set<(head: number) => void>()

  notify(head: number): void {
    this.head = Math.max(this.head, head)
    for (const listener of this.listeners) listener(this.head)
  }

  awaitHead = (cursor: number): Effect.Effect<number> => Effect.callback((resume) => {
    if (this.head > cursor) { resume(Effect.succeed(this.head)); return }
    const listener = (head: number) => { if (head > cursor) resume(Effect.succeed(head)) }
    this.listeners.add(listener)
    return Effect.sync(() => { this.listeners.delete(listener) })
  })
}
