import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/unstable/http"
import { AUTH_DEFAULTS, CodexAuthError, CodexCredentials, codexOAuthLayer, credentialsFromTokens, deviceLogin, type Tokens } from "./codex-auth"
import { oauthFixture } from "../testing/fixtures/oauth"

const authFixture = (options: { readonly loginStatus?: number; readonly stallLogin?: boolean; readonly holdRefresh?: boolean } = {}) => {
  const stalled = Promise.withResolvers<Response>()
  const fixture = oauthFixture({
    clientId: AUTH_DEFAULTS.clientId,
    accessToken: generation => `header.${Buffer.from(JSON.stringify({ exp: generation === 0 ? 0 : 9_999_999_999, "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.signature`,
    authorization: { code: "authorization", verifier: "verifier", redirectPath: "/deviceauth/callback" },
    ...(options.holdRefresh === undefined ? {} : { holdRefresh: options.holdRefresh }),
    route: ({ path, body, approved }) => {
      if (path === "/api/accounts/deviceauth/usercode") {
        if (options.stallLogin) return stalled.promise
        if (options.loginStatus !== undefined) return Response.json({ secret: "private-secret" }, { status: options.loginStatus })
        if (body.client_id !== AUTH_DEFAULTS.clientId) return new Response("Invalid client", { status: 400 })
        return Response.json({ device_auth_id: "device", user_code: "fixture-code", interval: 0.001 })
      }
      if (path === "/api/accounts/deviceauth/token") {
        if (body.device_auth_id !== "device" || body.user_code !== "fixture-code") return new Response("Invalid device", { status: 400 })
        return approved
          ? Response.json({ authorization_code: "authorization", code_verifier: "verifier" })
          : new Response("Pending", { status: 403 })
      }
      return undefined
    }
  })
  return { ...fixture, close: () => { stalled.resolve(new Response("Closed", { status: 503 })); fixture.close() } }
}

const login = (fixture: ReturnType<typeof authFixture>) => deviceLogin(code => Effect.sync(() => {
  expect(code).toEqual({ url: `${fixture.issuer}/codex/device`, code: "fixture-code" })
  fixture.approve()
}), { issuer: fixture.issuer, pollMs: 1 })

const persist = (file: string) => (tokens: Tokens) => Effect.tryPromise({
  try: () => writeFile(file, JSON.stringify(tokens), { mode: 0o600 }),
  catch: () => new CodexAuthError({ message: "Cannot persist fixture credentials" })
})

const withAuthFixture = <A, E>(options: Parameters<typeof authFixture>[0], run: (fixture: ReturnType<typeof authFixture>) => Effect.Effect<A, E, HttpClient.HttpClient>) =>
  Effect.runPromise(Effect.acquireUseRelease(
    Effect.sync(() => authFixture(options)), run, fixture => Effect.sync(() => fixture.close())
  ).pipe(Effect.provide(FetchHttpClient.layer), Effect.timeout(2000)))

for (const cancel of [false, true]) {
  test(`HTTP login and renewal persist across restart${cancel ? " after caller cancellation" : " with concurrent callers"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-auth-"))
    const file = join(directory, "credentials.json")
    try {
      await withAuthFixture({ holdRefresh: true }, fixture => Effect.gen(function* () {
        const initial = yield* login(fixture)
        yield* persist(file)(initial)
        const auth = yield* CodexCredentials.pipe(Effect.provide(codexOAuthLayer({ tokens: initial, issuer: fixture.issuer, persist: persist(file) })))
        const first = yield* auth.credentials.pipe(Effect.forkChild)
        yield* Effect.promise(() => fixture.rotated)
        if (cancel) yield* Effect.sync(() => first.interruptUnsafe())
        const second = yield* auth.credentials.pipe(Effect.forkChild)
        fixture.release()
        if (cancel) yield* Fiber.await(first)
        else expect((yield* Fiber.join(first)).accountId).toBe("fixture-account")
        expect((yield* Fiber.join(second)).accountId).toBe("fixture-account")
        const persisted: Tokens = JSON.parse(yield* Effect.promise(() => readFile(file, "utf8")))
        expect(persisted.refreshToken).toBe("refresh-1")
        expect(fixture.requests.filter(request => request.body.grant_type === "refresh_token").map(request => request.body.refresh_token)).toEqual(["refresh-0"])
        const restarted = yield* CodexCredentials.pipe(Effect.provide(codexOAuthLayer({ tokens: { ...persisted, expiresAt: 0 }, issuer: fixture.issuer, persist: persist(file) })))
        expect((yield* restarted.credentials).accountId).toBe("fixture-account")
        const afterRestart: Tokens = JSON.parse(yield* Effect.promise(() => readFile(file, "utf8")))
        expect(afterRestart.refreshToken).toBe("refresh-2")
        expect(fixture.requests.filter(request => request.body.grant_type === "refresh_token").map(request => request.body.refresh_token)).toEqual(["refresh-0", "refresh-1"])
      }))
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
}

test("valid credentials make no HTTP requests", () => withAuthFixture({}, fixture => Effect.gen(function* () {
  const auth = yield* credentialsFromTokens({ accessToken: "token", accountId: "account", refreshToken: "refresh", expiresAt: 9_999_999_999_000 }, { issuer: fixture.issuer })
  expect((yield* auth.credentials).accessToken).toBe("token")
  expect(fixture.requests).toHaveLength(0)
})))

test("HTTP authentication failures exclude response contents", () => withAuthFixture({ loginStatus: 401 }, fixture => Effect.gen(function* () {
  const result = yield* login(fixture).pipe(Effect.result)
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") {
    expect(result.failure.message).toContain("authentication response")
    expect(JSON.stringify(result.failure)).not.toContain("private-secret")
  }
})))

class TokenStore extends Context.Service<TokenStore, {
  readonly save: (tokens: Tokens) => Effect.Effect<void, CodexAuthError>
}>()("test/TokenStore") {}

test("OAuth layer captures storage dependencies and retries failed saves without another exchange", () => withAuthFixture({}, fixture => Effect.gen(function* () {
  const attempted: string[] = []
  const saved: string[] = []
  const initial = yield* login(fixture)
  const credentials = codexOAuthLayer({
    tokens: initial, issuer: fixture.issuer,
    persist: tokens => Effect.gen(function* () {
      const store = yield* TokenStore
      yield* store.save(tokens)
    })
  }).pipe(Layer.provide(Layer.succeed(TokenStore, {
    save: tokens => Effect.suspend(() => {
      attempted.push(tokens.refreshToken)
      if (attempted.length === 1) return Effect.fail(new CodexAuthError({ message: "Storage unavailable" }))
      return Effect.sync(() => { saved.push(tokens.refreshToken) })
    })
  })))
  const auth = yield* CodexCredentials.pipe(Effect.provide(credentials))
  expect((yield* Effect.result(auth.credentials))._tag).toBe("Failure")
  expect(saved).toEqual([])
  expect((yield* auth.credentials).accountId).toBe("fixture-account")
  expect(attempted).toEqual(["refresh-1", "refresh-1"])
  expect(saved).toEqual(["refresh-1"])
  expect(fixture.requests.filter(request => request.body.grant_type === "refresh_token")).toHaveLength(1)
})))

test("HTTP authentication request timeout is configurable", () => withAuthFixture({ stallLogin: true }, fixture => Effect.gen(function* () {
  const result = yield* deviceLogin(() => Effect.void, { issuer: fixture.issuer, requestMs: 20 }).pipe(Effect.result)
  expect(result._tag).toBe("Failure")
  expect(fixture.requests).toHaveLength(1)
})))

test("HTTP refresh timeout remains bounded during protected renewal", () => withAuthFixture({ holdRefresh: true }, fixture => Effect.gen(function* () {
  const initial = yield* login(fixture)
  const auth = yield* credentialsFromTokens(initial, { issuer: fixture.issuer, requestMs: 50 })
  expect((yield* Effect.result(auth.credentials))._tag).toBe("Failure")
  expect(fixture.requests.filter(request => request.body.grant_type === "refresh_token")).toHaveLength(1)
})))

for (const cancel of [false, true]) {
  test(`persistence timeout releases renewal and retries the rotated tokens${cancel ? " after cancellation" : ""}`, () => withAuthFixture({}, fixture => Effect.gen(function* () {
    let attempts = 0
    let interrupted = false
    const saved: string[] = []
    const started = yield* Deferred.make<void>()
    const initial = yield* login(fixture)
    const auth = yield* CodexCredentials.pipe(Effect.provide(codexOAuthLayer({
      tokens: initial, issuer: fixture.issuer, persistMs: 20,
      persist: tokens => Effect.gen(function* () {
        attempts++
        if (attempts === 1) {
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { interrupted = true })))
        }
        saved.push(tokens.refreshToken)
      })
    })))
    const first = yield* auth.credentials.pipe(Effect.result, Effect.forkChild)
    yield* Deferred.await(started)
    if (cancel) {
      yield* Effect.sync(() => first.interruptUnsafe())
      expect((yield* Fiber.await(first))._tag).toBe("Failure")
    } else {
      const result = yield* Fiber.join(first)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.message).toContain("persistence exceeded 20ms")
    }
    expect(interrupted).toBe(true)
    expect((yield* auth.credentials).accountId).toBe("fixture-account")
    expect(saved).toEqual(["refresh-1"])
    expect(attempts).toBe(2)
    expect(fixture.requests.filter(request => request.body.grant_type === "refresh_token")).toHaveLength(1)
  })))
}
