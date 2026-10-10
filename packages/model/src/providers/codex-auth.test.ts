import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AUTH_DEFAULTS, CodexAuthError, credentialsFromTokens, deviceLogin } from "./codex-auth"

const token = (expiresAt: number) => `header.${Buffer.from(JSON.stringify({ exp: expiresAt, "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.signature`

test("device login and shared credentials renew once across concurrent requests", async () => {
  let refreshes = 0
  let saved = ""
  const client = HttpClient.make((request, url) => Effect.sync(() => {
    let body: unknown
    if (url.pathname.endsWith("/usercode")) body = { device_auth_id: "device", user_code: "code", interval: 0.001 }
    else if (url.pathname.endsWith("/deviceauth/token")) body = { authorization_code: "authorization", code_verifier: "verifier" }
    else {
      if (request.body._tag !== "Uint8Array") throw new Error("Expected authentication data")
      const form = new URLSearchParams(new TextDecoder().decode(request.body.body))
      const refresh = form.get("grant_type") === "refresh_token"
      if (refresh) { refreshes++; expect(form.get("refresh_token")).toBe("refresh-token") }
      body = { access_token: token(refresh ? 9_999_999_999 : 0), refresh_token: refresh ? "rotated-token" : "refresh-token" }
    }
    return HttpClientResponse.fromWeb(request, Response.json(body))
  }))
  const values = await Effect.runPromise(Effect.gen(function* () {
    const tokens = yield* deviceLogin(code => Effect.sync(() => expect(code).toEqual({ url: "https://auth.example/codex/device", code: "code" })), { issuer: "https://auth.example", pollMs: 1 })
    const auth = yield* credentialsFromTokens(tokens, {}, tokens => Effect.sync(() => { saved = tokens.refreshToken }))
    return yield* Effect.all([auth.credentials, auth.credentials], { concurrency: "unbounded" })
  }).pipe(Effect.provideService(HttpClient.HttpClient, client)))
  expect(refreshes).toBe(1)
  expect(saved).toBe("rotated-token")
  expect(values[0]?.accountId).toBe("account")
  expect(values[0]).toEqual(values[1])
})

test("valid credentials do not start login or renewal", async () => {
  const client = HttpClient.make(() => Effect.die("No authentication request is permitted"))
  const value = await Effect.runPromise(Effect.gen(function* () {
    const auth = yield* credentialsFromTokens({ accessToken: "token", accountId: "account", refreshToken: "refresh", expiresAt: 9_999_999_999_000 })
    return yield* auth.credentials
  }).pipe(Effect.provideService(HttpClient.HttpClient, client)))
  expect(value.accessToken).toBe("token")
})

test("authentication failures exclude token and response contents", async () => {
  const client = HttpClient.make(request => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ secret: "private-secret" }, { status: 401 }))))
  const result = await Effect.runPromise(deviceLogin(() => Effect.void, { ...AUTH_DEFAULTS, pollMs: 1 }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.result))
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") {
    expect(result.failure.message).toContain("authentication response")
    expect(JSON.stringify(result.failure)).not.toContain("private-secret")
  }
})

test("failed persistence retries the rotated token without another exchange", async () => {
  let exchanges = 0
  let saves = 0
  const client = HttpClient.make(request => Effect.sync(() => {
    exchanges++
    return HttpClientResponse.fromWeb(request, Response.json({ access_token: token(9_999_999_999), refresh_token: "rotated" }))
  }))
  await Effect.runPromise(Effect.gen(function* () {
    const auth = yield* credentialsFromTokens({ accessToken: "expired", accountId: "account", refreshToken: "old", expiresAt: 0 }, {}, () => Effect.suspend(() => {
      saves++
      return saves === 1 ? Effect.fail(new CodexAuthError({ message: "Storage unavailable" })) : Effect.void
    }))
    expect((yield* Effect.result(auth.credentials))._tag).toBe("Failure")
    expect((yield* auth.credentials).accessToken).toBe(token(9_999_999_999))
  }).pipe(Effect.provideService(HttpClient.HttpClient, client)))
  expect(exchanges).toBe(1)
  expect(saves).toBe(2)
})

test("authentication request timeout is configurable", async () => {
  const client = HttpClient.make(() => Effect.never)
  const result = await Effect.runPromise(deviceLogin(() => Effect.void, { requestMs: 1 }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.result))
  expect(result._tag).toBe("Failure")
})
