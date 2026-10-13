export interface OAuthFixtureRequest {
  readonly path: string
  readonly body: Readonly<Record<string, string>>
  readonly issuer: string
  readonly approved: boolean
}

export interface OAuthFixtureOptions {
  readonly clientId: string
  readonly accessToken: (generation: number) => string
  readonly tokenPath?: string
  readonly authorization?: { readonly code: string; readonly verifier: string; readonly redirectPath: string }
  readonly route?: (request: OAuthFixtureRequest) => Response | Promise<Response> | undefined
  readonly holdRefresh?: boolean
}

// oauthFixture models single-use refresh tokens and configurable authorization routes over HTTP (providers/codex-auth.test.ts).
export const oauthFixture = (options: OAuthFixtureOptions) => {
  const rotated = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const requests: Array<OAuthFixtureRequest> = []
  let approved = false
  let generation = 0
  let refreshToken = "refresh-0"
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request): Promise<Response> => {
      if (request.method !== "POST") return new Response("Expected POST", { status: 405 })
      const path = new URL(request.url).pathname
      const body = request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")
        ? Object.fromEntries(new URLSearchParams(await request.text()))
        : await request.json() as Record<string, string>
      const received = { path, body, issuer: server.url.origin, approved }
      requests.push(received)
      const routed = options.route?.(received)
      if (routed !== undefined) return routed
      if (path !== (options.tokenPath ?? "/oauth/token")) return new Response("Unknown endpoint", { status: 404 })
      if (body.client_id !== options.clientId) return new Response("Invalid client", { status: 400 })
      if (body.grant_type === "authorization_code") {
        const authorization = options.authorization
        if (authorization === undefined || body.code !== authorization.code || body.code_verifier !== authorization.verifier || body.redirect_uri !== new URL(authorization.redirectPath, server.url).href) return new Response("Invalid exchange", { status: 400 })
        return Response.json({ access_token: options.accessToken(generation), refresh_token: refreshToken })
      }
      if (body.grant_type !== "refresh_token" || body.refresh_token !== refreshToken) return new Response("Refresh token already used", { status: 401 })
      refreshToken = `refresh-${++generation}`
      const result = JSON.stringify({ access_token: options.accessToken(generation), refresh_token: refreshToken })
      if (!options.holdRefresh) return new Response(result, { headers: { "content-type": "application/json" } })
      let cancelled = false
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(" "))
          rotated.resolve()
          void release.promise.then(() => {
            if (!cancelled) { controller.enqueue(new TextEncoder().encode(result)); controller.close() }
          })
        },
        cancel() { cancelled = true }
      })
      return new Response(stream, { headers: { "content-type": "application/json" } })
    }
  })
  return {
    issuer: server.url.origin,
    requests,
    rotated: rotated.promise,
    approve: () => { approved = true },
    release: () => release.resolve(),
    close: () => { release.resolve(); server.stop(true) }
  }
}
