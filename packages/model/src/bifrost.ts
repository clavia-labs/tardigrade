import { Context, Data, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

export class BifrostError extends Data.TaggedError("BifrostError")<{ readonly message: string; readonly status?: number }> {}
const failure = (message: string) => new BifrostError({ message })

export const BifrostHandle = Schema.Struct({ executor: Schema.Literal("bifrost"), id: Schema.NonEmptyString, endpoint: Schema.NonEmptyString, mode: Schema.optionalKey(Schema.Literal("push")) })
export type BifrostHandle = typeof BifrostHandle.Type

const Submission = Schema.Struct({ id: Schema.NonEmptyString, status: Schema.Literals(["pending", "processing"]) })
const Job = Schema.Union([
  Schema.Struct({ id: Schema.NonEmptyString, status: Schema.Literals(["pending", "processing"]) }),
  Schema.Struct({ id: Schema.NonEmptyString, status: Schema.Literal("completed"), result: Schema.Unknown }),
  Schema.Struct({ id: Schema.NonEmptyString, status: Schema.Literal("failed"), error: Schema.Unknown }),
])

export const DEFAULT_BIFROST_REQUEST_TIMEOUT_MS = 30_000
export const DEFAULT_BIFROST_RESULT_TTL_SECONDS = 3_600

export interface BifrostOptions {
  readonly baseUrl: string
  readonly apiKey?: Redacted.Redacted<string>
  // webhookEndpoint names an enabled Bifrost endpoint subscribed to async_job.completed and async_job.failed.
  readonly webhookEndpoint?: string
  readonly requestTimeoutMs?: number
  readonly resultTtlSeconds?: number
}

export class Bifrost extends Context.Service<Bifrost, {
  readonly call: (body: Readonly<Record<string, unknown>>) => Effect.Effect<unknown, Error>
  readonly submit: (body: Readonly<Record<string, unknown>>) => Effect.Effect<BifrostHandle, Error>
  readonly poll: (handle: BifrostHandle) => Effect.Effect<{ readonly status: "pending" } | { readonly status: "fulfilled"; readonly value: unknown } | { readonly status: "rejected"; readonly error: string }, Error>
}>()("tardigrade/model/Bifrost") {}

// bifrostEndpoint derives the async chat endpoint from a configured gateway URL.
export function bifrostEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw failure("Bifrost baseUrl must be an HTTP gateway URL without credentials, query, or fragment")
  return `${url.href.replace(/\/$/, "")}/v1/async/chat/completions`
}

// bifrostLayer submits chat jobs without retries and polls their recorded handles (https://docs.getbifrost.ai/features/async-inference).
export function bifrostLayer(options: BifrostOptions) {
  return Layer.effect(Bifrost, Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const timeout = options.requestTimeoutMs ?? DEFAULT_BIFROST_REQUEST_TIMEOUT_MS
    const ttl = options.resultTtlSeconds ?? DEFAULT_BIFROST_RESULT_TTL_SECONDS
    const endpoint = yield* Effect.try(() => {
      for (const [name, value] of Object.entries({ requestTimeoutMs: timeout, resultTtlSeconds: ttl })) {
        if (!Number.isSafeInteger(value) || value <= 0) throw failure(`${name} must be a positive safe integer`)
      }
      if (options.webhookEndpoint !== undefined && !options.webhookEndpoint.trim()) throw failure("webhookEndpoint must not be empty")
      return bifrostEndpoint(options.baseUrl)
    })
    const request = (req: HttpClientRequest.HttpClientRequest) => client.execute(options.apiKey
      ? HttpClientRequest.setHeader(req, "x-bf-vk", Redacted.value(options.apiKey)) : req).pipe(
      Effect.flatMap(response => Effect.gen(function* () {
        if (response.status !== 200 && response.status !== 202) return yield* new BifrostError({ message: `Bifrost HTTP ${response.status}`, status: response.status })
        return yield* response.json
      })),
      Effect.timeout(timeout),
      Effect.mapError(error => error instanceof BifrostError ? error : failure(`Bifrost request failed: ${error instanceof Error ? error.message : String(error)}`)),
    )
    return {
      call: body => HttpClientRequest.bodyJson(HttpClientRequest.post(endpoint.replace("/v1/async/", "/v1/")), { ...body, stream: false }).pipe(Effect.flatMap(request)),
      submit: body => Effect.gen(function* () {
        const req = yield* HttpClientRequest.bodyJson(HttpClientRequest.post(endpoint, {
          headers: { "x-bf-async-job-result-ttl": String(ttl), ...(options.webhookEndpoint ? { "x-bf-async-webhook": options.webhookEndpoint } : {}) },
        }), { ...body, stream: false })
        const job = yield* Schema.decodeUnknownEffect(Submission)(yield* request(req))
        return { executor: "bifrost", id: job.id, endpoint, ...(options.webhookEndpoint ? { mode: "push" as const } : {}) }
      }),
      poll: handle => Effect.gen(function* () {
        if (handle.endpoint !== endpoint) return yield* failure("Bifrost handle belongs to a different endpoint")
        const job = yield* Schema.decodeUnknownEffect(Job)(yield* request(HttpClientRequest.get(`${endpoint}/${encodeURIComponent(handle.id)}`)))
        if (job.id !== handle.id) return yield* failure("Bifrost returned a different job identity")
        if (job.status === "completed") return { status: "fulfilled" as const, value: job.result }
        if (job.status === "failed") return { status: "rejected" as const, error: `Bifrost job failed: ${JSON.stringify(job.error)}` }
        return { status: "pending" as const }
      }).pipe(Effect.catchIf(error => error instanceof BifrostError && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 429, error => Effect.succeed({ status: "rejected" as const, error: error.message }))),
    } satisfies typeof Bifrost.Service
  }))
}
