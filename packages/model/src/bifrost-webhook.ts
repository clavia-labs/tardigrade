import { Clock, Effect, Redacted, Schema } from "effect"
import { BifrostError, bifrostEndpoint } from "./bifrost"

export const DEFAULT_BIFROST_WEBHOOK_POLICY = { toleranceSeconds: 300, maxBodyBytes: 1_048_576 } as const
export interface BifrostWebhookOptions {
  readonly baseUrl: string
  readonly secret: Redacted.Redacted<string>
  readonly toleranceSeconds?: number
  readonly maxBodyBytes?: number
}

const Envelope = Schema.Struct({
  event: Schema.Literals(["async_job.completed", "async_job.failed"]),
  data: Schema.Struct({
    job_id: Schema.NonEmptyString,
    request_type: Schema.Literal("chat_completion"),
    status: Schema.Literals(["completed", "failed"]),
    response: Schema.optionalKey(Schema.Json),
    error: Schema.optionalKey(Schema.Json),
    result_expired: Schema.optionalKey(Schema.Boolean),
  }),
})
const invalid = () => new BifrostError({ message: "Invalid Bifrost webhook" })
const bytes = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0))

// bifrostWebhookVerifier authenticates raw deliveries before decoding them (https://docs.getbifrost.ai/features/webhooks).
export function bifrostWebhookVerifier(options: BifrostWebhookOptions) {
  return Effect.tryPromise({ try: async () => {
    const endpoint = bifrostEndpoint(options.baseUrl)
    const tolerance = options.toleranceSeconds ?? DEFAULT_BIFROST_WEBHOOK_POLICY.toleranceSeconds
    const limit = options.maxBodyBytes ?? DEFAULT_BIFROST_WEBHOOK_POLICY.maxBodyBytes
    for (const [name, value] of Object.entries({ toleranceSeconds: tolerance, maxBodyBytes: limit })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new BifrostError({ message: `${name} must be a positive safe integer` })
    }
    const secret = bytes(Redacted.value(options.secret).replace(/^whsec_/, ""))
    if (!secret.length) throw invalid()
    const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["verify"])
    return (request: Request) => Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const verified = yield* Effect.tryPromise({ try: async signal => {
        const id = request.headers.get("webhook-id")
        const timestamp = request.headers.get("webhook-timestamp") ?? ""
        const signatures = request.headers.get("webhook-signature") ?? ""
        if (request.method !== "POST" || !id || !/^\d+$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp)) || Math.abs(now / 1_000 - Number(timestamp)) > tolerance) throw invalid()
        const reader = request.body?.getReader()
        if (!reader) throw invalid()
        const cancel = () => { void reader.cancel().catch(() => {}) }
        signal.addEventListener("abort", cancel, { once: true })
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.byteLength
            if (size > limit) throw invalid()
            chunks.push(chunk.value)
          }
        } finally { signal.removeEventListener("abort", cancel); await reader.cancel(); reader.releaseLock() }
        if (signal.aborted) throw invalid()
        const prefix = new TextEncoder().encode(`${id}.${timestamp}.`)
        const signed = new Uint8Array(prefix.length + size)
        signed.set(prefix)
        let offset = prefix.length
        for (const chunk of chunks) { signed.set(chunk, offset); offset += chunk.length }
        let verified = false
        for (const candidate of signatures.split(/\s+/)) {
          if (!candidate.startsWith("v1,")) continue
          try { verified = (await crypto.subtle.verify("HMAC", key, bytes(candidate.slice(3)), signed)) || verified } catch { continue }
        }
        if (!verified) throw invalid()
        return { id, body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(signed.subarray(prefix.length))) as unknown }
      }, catch: invalid })
      const envelope = yield* Schema.decodeUnknownEffect(Envelope)(verified.body)
      if (envelope.event !== `async_job.${envelope.data.status}`) return yield* invalid()
      return { id: verified.id, handle: { executor: "bifrost" as const, id: envelope.data.job_id, endpoint, mode: "push" as const }, data: envelope.data }
    })
  }, catch: error => error instanceof BifrostError ? error : invalid() })
}
