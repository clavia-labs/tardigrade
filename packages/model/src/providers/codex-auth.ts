import { Clock, Context, Data, Effect, Encoding, Ref, Schema, Semaphore } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

export const AUTH_DEFAULTS = {
  issuer: "https://auth.openai.com",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  requestMs: 30_000,
  loginMs: 900_000,
  pollMs: 5_000,
  refreshMarginMs: 60_000
}
export type AuthOptions = Partial<typeof AUTH_DEFAULTS>
export interface Credentials { readonly accessToken: string; readonly accountId: string }
export interface Tokens extends Credentials { readonly refreshToken: string; readonly expiresAt: number }
export class CodexAuthError extends Data.TaggedError("CodexAuthError")<{ readonly message: string }> {}
export class CodexCredentials extends Context.Service<CodexCredentials, {
  readonly credentials: Effect.Effect<Credentials, CodexAuthError>
}>()("tardie/CodexCredentials") {}

const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))
const required = Schema.decodeUnknownSync(Schema.NonEmptyString)
const claims = (token: string) => {
  const decoded = Encoding.decodeBase64UrlString(required(token.split(".")[1]))
  if (decoded._tag === "Failure") throw new Error("Invalid token")
  return record(JSON.parse(decoded.success))
}
const authError = () => new CodexAuthError({ message: "Invalid Codex credentials or authentication response" })

// credentialsFromAccessToken reads routing claims without treating them as verified identity (codex.test.ts).
export const credentialsFromAccessToken = (accessToken: string): Credentials => {
  try {
    const account = record(claims(accessToken)["https://api.openai.com/auth"])
    return { accessToken, accountId: required(account.chatgpt_account_id) }
  } catch { throw authError() }
}

const exchange = Effect.fn("Codex.exchange")(function* (options: typeof AUTH_DEFAULTS, form: Record<string, string>, previous?: Tokens) {
  const http = yield* HttpClient.HttpClient
  const response = yield* http.execute(HttpClientRequest.post(`${options.issuer}/oauth/token`).pipe(
    HttpClientRequest.bodyText(new URLSearchParams({ client_id: options.clientId, ...form }).toString(), "application/x-www-form-urlencoded")
  ))
  if (response.status < 200 || response.status >= 300) return yield* authError()
  const raw = yield* response.json
  return yield* Effect.try({ try: (): Tokens => {
    const body = record(raw)
    const accessToken = required(body.access_token)
    const access = claims(accessToken)
    const identity = body.id_token ? claims(required(body.id_token)) : access
    const account = record(identity["https://api.openai.com/auth"] ?? access["https://api.openai.com/auth"] ?? {})
    if (typeof access.exp !== "number" || !Number.isFinite(access.exp)) throw new Error("Missing token expiry")
    return { accessToken, refreshToken: required(body.refresh_token ?? previous?.refreshToken), accountId: required(account.chatgpt_account_id ?? previous?.accountId), expiresAt: access.exp * 1000 }
  }, catch: authError })
})

// deviceLogin obtains tokens through an explicit device-code callback (codex-auth.test.ts).
export const deviceLogin = Effect.fn("Codex.deviceLogin")(function* (
  onCode: (code: { readonly url: string; readonly code: string }) => Effect.Effect<void>,
  overrides: AuthOptions = {}
) {
  const options = { ...AUTH_DEFAULTS, ...overrides }
  const http = yield* HttpClient.HttpClient
  const post = (path: string, body: unknown) => http.execute(HttpClientRequest.post(`${options.issuer}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body)))
  const read = Effect.fn(function* (path: string, body: unknown) {
    const response = yield* post(path, body)
    if (response.status < 200 || response.status >= 300) return yield* authError()
    return yield* response.json
  })
  return yield* Effect.gen(function* () {
    const raw = yield* read("/api/accounts/deviceauth/usercode", { client_id: options.clientId }).pipe(Effect.timeout(options.requestMs))
    const device = yield* Effect.try({ try: () => {
      const body = record(raw)
      const interval = Number(body.interval) * 1000
      return { id: required(body.device_auth_id), code: required(body.user_code ?? body.usercode), interval: Number.isFinite(interval) && interval > 0 ? Math.max(interval, options.pollMs) : options.pollMs }
    }, catch: authError })
    yield* onCode({ url: `${options.issuer}/codex/device`, code: device.code })
    for (;;) {
      yield* Effect.sleep(device.interval)
      const result = yield* Effect.gen(function* () {
        const response = yield* post("/api/accounts/deviceauth/token", { device_auth_id: device.id, user_code: device.code })
        if (response.status === 403 || response.status === 404) { yield* response.text; return undefined }
        if (response.status < 200 || response.status >= 300) return yield* authError()
        return yield* response.json
      }).pipe(Effect.timeout(options.requestMs))
      if (result === undefined) continue
      const form = yield* Effect.try({ try: () => {
        const body = record(result)
        return { grant_type: "authorization_code", code: required(body.authorization_code), code_verifier: required(body.code_verifier), redirect_uri: `${options.issuer}/deviceauth/callback` }
      }, catch: authError })
      return yield* exchange(options, form).pipe(Effect.timeout(options.requestMs))
    }
  }).pipe(Effect.timeout(options.loginMs), Effect.mapError(authError))
})

// credentialsFromTokens serializes renewal and retains rotated tokens across requests (codex-auth.test.ts).
export const credentialsFromTokens = Effect.fn("Codex.credentialsFromTokens")(function* (
  initial: Tokens,
  overrides: AuthOptions = {},
  onRefresh: (tokens: Tokens) => Effect.Effect<void, CodexAuthError> = () => Effect.void
) {
  const options = { ...AUTH_DEFAULTS, ...overrides }
  const http = yield* HttpClient.HttpClient
  const tokens = yield* Ref.make(initial)
  const pendingSave = yield* Ref.make(false)
  const lock = yield* Semaphore.make(1)
  return { credentials: lock.withPermits(1)(Effect.gen(function* () {
    let current = yield* Ref.get(tokens)
    if (current.expiresAt <= (yield* Clock.currentTimeMillis) + options.refreshMarginMs) {
      current = yield* exchange(options, { grant_type: "refresh_token", refresh_token: current.refreshToken }, current).pipe(
        Effect.provideService(HttpClient.HttpClient, http), Effect.timeout(options.requestMs), Effect.mapError(authError)
      )
      yield* Ref.set(tokens, current)
      yield* Ref.set(pendingSave, true)
    }
    if (yield* Ref.get(pendingSave)) {
      yield* onRefresh(current)
      yield* Ref.set(pendingSave, false)
    }
    return { accessToken: current.accessToken, accountId: current.accountId }
  })) }
})
