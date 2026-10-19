import { expect, test } from "bun:test"
import { Duration, Redacted } from "effect"
import { AiError } from "effect/unstable/ai"
import { DEFAULT_MODEL_ERROR_REDACTED_HEADERS, encodeModelError, modelErrorOf } from "./error"

const sensitiveHeaders = [
  "Authorization", "PROXY-AUTHORIZATION", "X-Bf-Vk", "X-API-Key", "Api-Key", "Cookie", "Set-Cookie", "X-Access-ToKeN", "X-Client-SeCrEt",
]

test("model errors redact request and response credentials before persistence", () => {
  const secrets = sensitiveHeaders.flatMap((_, index) => [`synthetic-request-${index}`, `synthetic-response-${index}`])
  const requestHeaders = Object.fromEntries(sensitiveHeaders.map((name, index) => [name, secrets[index * 2]!]))
  const responseHeaders = Object.fromEntries(sensitiveHeaders.map((name, index) => [name, secrets[index * 2 + 1]!]))
  const http = {
    request: {
      method: "POST" as const, url: "https://provider.example/inference", urlParams: [["model", "test"]] as Array<[string, string]>,
      headers: { ...requestHeaders, "Content-Type": "application/json", "X-Wrapped": Redacted.make("synthetic-wrapped-request") },
    },
    response: { status: 429, headers: { ...responseHeaders, "Retry-After": "3", "X-Wrapped": Redacted.make("synthetic-wrapped-response") } },
    body: "provider diagnostic",
  }
  const error = AiError.make({ module: "test", method: "inference", reason: AiError.RateLimitError.make({ retryAfter: Duration.seconds(3), http }) })
  const encoded = encodeModelError(error)
  const persisted = JSON.stringify(encoded)
  for (const secret of [...secrets, "synthetic-wrapped-request", "synthetic-wrapped-response"]) expect(persisted).not.toContain(secret)
  const markers = Object.fromEntries(sensitiveHeaders.map(name => [name, "[REDACTED]"]))
  expect(encoded).toMatchObject({
    module: "test", method: "inference",
    reason: { http: {
      request: { method: "POST", url: http.request.url, urlParams: [["model", "test"]], headers: { ...markers, "Content-Type": "application/json", "X-Wrapped": "[REDACTED]" } },
      response: { status: 429, headers: { ...markers, "Retry-After": "3", "X-Wrapped": "[REDACTED]" } },
      body: "provider diagnostic",
    } },
  })
  expect(Duration.toMillis(modelErrorOf(encoded)!.retryAfter!)).toBe(3000)
  expect(http.request.headers).toMatchObject({ Authorization: "synthetic-request-0" })
  expect(http.response.headers).toMatchObject({ "Set-Cookie": "synthetic-response-6" })
})

test("header redaction supports caller policy extensions without a response", () => {
  const error = AiError.make({ module: "test", method: "inference", reason: AiError.RateLimitError.make({ http: {
    request: { method: "GET", url: "https://provider.example", urlParams: [], headers: { Authorization: "synthetic-auth", "X-Custom-Credential": "synthetic-custom", "X-Request-Id": "request-1" } },
  } }) })
  expect(JSON.stringify(encodeModelError(error))).toContain("synthetic-custom")
  const encoded = encodeModelError(error, [...DEFAULT_MODEL_ERROR_REDACTED_HEADERS, "x-custom-credential"])
  expect(JSON.stringify(encoded)).not.toContain("synthetic-custom")
  expect(JSON.stringify(encoded)).not.toContain("synthetic-auth")
  expect(encoded).toMatchObject({ reason: { http: { request: { headers: { Authorization: "[REDACTED]", "X-Custom-Credential": "[REDACTED]", "X-Request-Id": "request-1" } } } } })
})

test("network errors redact request headers without an HTTP context", () => {
  const error = AiError.make({ module: "test", method: "inference", reason: AiError.NetworkError.make({
    reason: "TransportError", description: "connection closed",
    request: { method: "POST", url: "https://provider.example", urlParams: [], headers: { Authorization: "synthetic-network", "Content-Type": "application/json" } },
  }) })
  const encoded = encodeModelError(error)
  expect(JSON.stringify(encoded)).not.toContain("synthetic-network")
  expect(encoded).toMatchObject({ reason: { reason: "TransportError", description: "connection closed", request: { headers: { Authorization: "[REDACTED]", "Content-Type": "application/json" } } } })
})

test("model errors without HTTP details preserve their evidence", () => {
  const error = AiError.make({ module: "test", method: "inference", reason: AiError.UnknownError.make({ description: "provider failure", metadata: { test: { code: "diagnostic" } } }) })
  const encoded = encodeModelError(error)
  expect(encoded).toMatchObject({ reason: { _tag: "UnknownError", description: "provider failure", metadata: { test: { code: "diagnostic" } } } })
  expect(modelErrorOf(encoded)).toBeDefined()
})
