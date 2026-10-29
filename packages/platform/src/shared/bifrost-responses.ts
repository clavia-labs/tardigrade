import { DateTime, Effect, Option, Schema, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { EffectExecution, ExternalExecution, ExternalCancellationError, RuntimeError, type ExecutionHandle, type ResolutionPoll } from "@clavia/tardigrade-core"

export interface BifrostResponsesOptions {
  readonly endpoint: string
  readonly responsesUrl?: string | undefined
  /** Provider metadata reader (OpenAiClient.getRequestBody); must not consume lazy file sources. */
  readonly requestBody?: (request: HttpClientRequest.HttpClientRequest) => unknown
  readonly deadlineAt: (execution: typeof EffectExecution.Service) => Effect.Effect<number, Error>
  readonly requestTimeoutMs?: number
}
export const DEFAULT_BIFROST_RESPONSES_REQUEST_TIMEOUT_MS = 30_000
// Header values must remain printable ASCII; escape UTF-16 code units without changing the retained identity.
const encodeIdentityHeader = (key: string) => key.replace(/[^\x20-\x7e]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
const Submission = Schema.Struct({ id: Schema.NonEmptyString })
const Job = Schema.Struct({ id: Schema.NonEmptyString, status: Schema.Literals(["pending", "processing", "completed", "failed", "cancelled"]), result: Schema.optionalKey(Schema.Json), error: Schema.optionalKey(Schema.Json) })
// BifrostAsyncFailure is the scripted async failure contract; gateway support must be verified before enabling a route.
export const BifrostAsyncFailure = Schema.Struct({ status: Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 })), code: Schema.NonEmptyString, message: Schema.String, retryAfterMs: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))) })
const endpointOf = (value: string) => {
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/async/responses")) throw new RuntimeError("Expected an async Responses endpoint without credentials, query or fragment")
  return url.href
}
const handleUrl = (endpoint: string, handle: ExecutionHandle) => {
  if (handle.executor !== "bifrost-responses" || handle.endpoint !== endpoint) throw new RuntimeError("Async Responses handle belongs to another endpoint")
  return `${endpoint}/${encodeURIComponent(handle.id)}`
}
const terminalCodes = new Set(["authentication_error", "invalid_api_key", "invalid_request_error", "context_length_exceeded", "context_window_exceeded", "content_filter", "content_policy_violation", "data_inspection_failed", "refusal", "deadline_exceeded", "async_job_deadline_exceeded", "cancelled", "insufficient_quota", "async_poll_rejected", "async_invalid_response", "async_job_identity_mismatch"])
const failureStatus = (failure: typeof BifrostAsyncFailure.Type) => terminalCodes.has(failure.code) ? (["authentication_error", "invalid_api_key"].includes(failure.code) ? 401 : [401, 403].includes(failure.status) ? failure.status : 400) : failure.code === "async_job_interrupted" ? 503 : failure.status
const failureResponse = (request: HttpClientRequest.HttpClientRequest, status: number, error: Schema.Json, retryAfterMs?: number) => new HttpClientError.HttpClientError({ reason: new HttpClientError.StatusCodeError({ request, response: HttpClientResponse.fromWeb(request, Response.json({ error }, { status, headers: retryAfterMs === undefined ? {} : { "retry-after": String(retryAfterMs / 1_000) } })) }) })
const invalidRequest = (request: HttpClientRequest.HttpClientRequest, message: string) => failureResponse(request, 400, { code: "invalid_request_error", type: "invalid_request_error", message })
// Lazy bodies require provider metadata so unary validation never opens image sources.
// Upload preserves the original stream and maps read failures like FetchHttpClient.
const parseJson = (text: string) => Effect.try(() => JSON.parse(text))
const prepareUnary = (request: HttpClientRequest.HttpClientRequest, metadata?: BifrostResponsesOptions["requestBody"]) => Effect.gen(function* () {
  const body = request.body
  const json: unknown = body._tag === "Stream"
    ? yield* Effect.try(() => metadata?.(request))
    : body._tag === "Uint8Array"
      ? yield* Effect.try(() => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.body)))
      : body._tag === "Raw" && typeof body.body === "string"
        ? yield* parseJson(body.body)
        : undefined
  if (json === null || typeof json !== "object" || Array.isArray(json) || "stream" in json && json.stream !== undefined && json.stream !== false) return yield* invalidRequest(request, "Async Responses requires a supported unary JSON body or provider metadata")
  if (body._tag !== "Stream") return request
  return HttpClientRequest.setBody(request, HttpBody.stream(body.stream.pipe(Stream.mapError(cause => new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, cause }) }))), body.contentType, body.contentLength))
}).pipe(Effect.mapError(error => HttpClientError.isHttpClientError(error) ? error : invalidRequest(request, "Invalid async Responses request body")))

// bifrostResponsesClient transports encoded Responses requests through native external execution; the provider retains its encoder, decoder and finish hooks.
export function bifrostResponsesClient(client: HttpClient.HttpClient, options: BifrostResponsesOptions): HttpClient.HttpClient {
  const endpoint = endpointOf(options.endpoint)
  const responsesUrl = options.responsesUrl ?? endpoint.replace(/\/async\/responses$/, "/responses")
  const expected = new URL(responsesUrl)
  if (expected.origin !== new URL(endpoint).origin || expected.username || expected.password || expected.search || expected.hash || !expected.pathname.endsWith("/responses") || expected.pathname.endsWith("/async/responses")) throw new RuntimeError("Expected a synchronous Responses URL on the async gateway origin")
  const timeout = options.requestTimeoutMs ?? DEFAULT_BIFROST_RESPONSES_REQUEST_TIMEOUT_MS
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new RuntimeError("Async Responses requestTimeoutMs must be a positive safe integer")
  return HttpClient.transform(client, (original, request) => {
    if (!new URL(request.url, endpoint).pathname.endsWith("/responses")) return original
    if (request.method !== "POST" || request.url !== responsesUrl) return Effect.fail(invalidRequest(request, "Unary Responses URL or method differs from the configured async transport mapping"))
    let prepared: HttpClientRequest.HttpClientRequest | undefined
    return Effect.gen(function* () {
      const service = yield* Effect.serviceOption(ExternalExecution)
      const execution = yield* Effect.serviceOption(EffectExecution)
      if (Option.isNone(service) || Option.isNone(execution)) return yield* Effect.fail(new RuntimeError("Async Responses requires native model submission"))
      const deadlineAt = yield* options.deadlineAt(execution.value)
      const result = yield* service.value.submit(identity => Effect.gen(function* () {
        const key = encodeIdentityHeader(identity.key)
        if (key.length > 4096) return yield* failureResponse(request, 400, { code: "async_idempotency_key_too_long", type: "invalid_request_error", message: "Async Responses idempotency key exceeds the 4096-byte header limit" })
        prepared ??= yield* prepareUnary(request, options.requestBody)
        const submission = HttpClientRequest.setHeaders(HttpClientRequest.setUrl(prepared, endpoint), {
          "x-bf-async-idempotency-key": key,
          "x-bf-async-deadline": DateTime.formatIso(DateTime.makeUnsafe(identity.deadlineAt)),
        })
        return yield* Effect.gen(function* () {
          const response = yield* client.postprocess(Effect.succeed(submission))
          const accepted = yield* Schema.decodeUnknownEffect(Submission)(yield* response.json)
          return { executor: "bifrost-responses", id: accepted.id, endpoint }
        }).pipe(Effect.timeout(timeout), Effect.catchTag("TimeoutError", () => Effect.fail(new RuntimeError(JSON.stringify({
          status: 503, code: "async_submission_timeout",
          message: "async_submission_timeout: Async submission acknowledgement timed out; outcome is unknown and retry must reuse the retained idempotency key",
        })))))
      }), { deadlineAt, cancel: handle => cancelRequest(client.postprocess(Effect.succeed(HttpClientRequest.removeHeader(HttpClientRequest.delete(handleUrl(endpoint, handle), { headers: request.headers }), "content-length"))), timeout) })
      return HttpClientResponse.fromWeb(request, Response.json(result))
    }).pipe(Effect.catch(error => {
      if (HttpClientError.isHttpClientError(error)) return Effect.fail(error)
      let failure: typeof BifrostAsyncFailure.Type | undefined
      try { failure = Schema.decodeUnknownSync(BifrostAsyncFailure)(JSON.parse(error.message)) } catch { /* Native expiry and codec failures are terminal. */ }
      return Effect.fail(failureResponse(request, failure ? failureStatus(failure) : 400, failure ? { code: failure.code, type: failure.code === "refusal" ? "content_filter" : failure.code, message: failure.message } : { message: error.message }, failure?.retryAfterMs))
    }))
  })
}

const rejected = (status: number, code: string, message: string) => ({ status: "rejected" as const, reason: JSON.stringify({ status, code, message }) })
// A status-filtered client can reject before the adapter sees the HTTP response.
const responseOrStatus = <E extends Error>(work: Effect.Effect<HttpClientResponse.HttpClientResponse, E>) => work.pipe(Effect.catch(error => HttpClientError.isHttpClientError(error) && error.reason._tag === "StatusCodeError" ? Effect.succeed(error.reason.response) : Effect.fail(error)))

// bifrostResponsesPoll distinguishes an observation outage from a terminal job failure.
export function bifrostResponsesPoll(client: HttpClient.HttpClient, endpointValue: string): ResolutionPoll {
  const endpoint = endpointOf(endpointValue)
  return handle => Effect.gen(function* () {
    const response = yield* responseOrStatus(client.get(yield* Effect.try(() => handleUrl(endpoint, handle))))
    const status = response.status
    if ([408, 425, 429].includes(status) || status >= 500) return yield* Effect.fail(new RuntimeError(`Async Responses observation failed with HTTP ${status}`))
    if (status === 404) return rejected(503, "async_job_missing", "Async Responses job is missing")
    if (status === 401 || status === 403) return rejected(status, "authentication_error", "Async Responses observation authorization failed")
    if (status < 200 || status >= 300) return rejected(status >= 400 && status < 500 ? status : 400, "async_poll_rejected", `Async Responses observation rejected with HTTP ${status}`)
    const decoded = yield* Effect.result(response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Job))))
    if (decoded._tag === "Failure") return rejected(400, "async_invalid_response", "Async Responses observation returned an invalid envelope")
    const job = decoded.success
    if (job.id !== handle.id) return rejected(400, "async_job_identity_mismatch", "Async Responses job identity differs from its handle")
    if (job.status === "completed") {
      if (job.result === undefined || job.result === null) return rejected(502, "async_result_missing", "Completed async Responses job has no result")
      return { status: "fulfilled" as const, value: job.result }
    }
    if (job.status === "failed" || job.status === "cancelled") return { status: "rejected" as const, reason: JSON.stringify(job.error ?? { status: 400, code: job.status === "cancelled" ? "cancelled" : "async_invalid_response", message: `Async Responses job ${job.status} without a typed failure` }) }
    return { status: "pending" as const }
  }).pipe(Effect.mapError(RuntimeError.from))
}

const cancelRequest = (work: Effect.Effect<HttpClientResponse.HttpClientResponse, Error>, timeoutMs: number) => responseOrStatus(work).pipe(
  Effect.interruptible,
  Effect.timeout(timeoutMs),
  Effect.flatMap(response => response.status >= 200 && response.status < 300 || response.status === 404
    ? Effect.void
    : response.status === 405 || response.status === 501
      ? Effect.fail(new ExternalCancellationError(`async_cancel_unsupported: HTTP ${response.status}`))
      : response.status < 500 && response.status !== 429
        ? Effect.fail(new ExternalCancellationError(`async_cancel_rejected: HTTP ${response.status}`))
        : Effect.fail(new RuntimeError(`Async Responses cancellation failed with HTTP ${response.status}`))),
  Effect.mapError(RuntimeError.from),
)

// Native cleanup retries transient DELETE failures within its retained deadline budget.
export const bifrostResponsesCancel = (client: HttpClient.HttpClient, endpointValue: string, options: { readonly requestTimeoutMs?: number } = {}) => {
  const endpoint = endpointOf(endpointValue)
  const timeout = options.requestTimeoutMs ?? DEFAULT_BIFROST_RESPONSES_REQUEST_TIMEOUT_MS
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new RuntimeError("Async Responses requestTimeoutMs must be a positive safe integer")
  return (handle: ExecutionHandle) => Effect.try(() => handleUrl(endpoint, handle)).pipe(Effect.flatMap(url => cancelRequest(client.del(url), timeout)), Effect.mapError(RuntimeError.from))
}
