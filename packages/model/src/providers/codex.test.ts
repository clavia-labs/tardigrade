import { expect, test } from "bun:test"
import { Console, Deferred, Effect, Fiber, Layer, Redacted, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { createProviderLayer, listModels, providerLayer } from "./codex"
import { providerLayer as loadProvider } from "./layer"
import { credentialsFromAccessToken } from "./codex-auth"
import { providerEvents, reasoning } from "../testing/fixtures"
import { ModelLock, modelLockOf, modelLockService } from "../lock"
import { modelLayer } from "../host"
import { BindingSettings, modelSettingsFor } from "../settings"
import { inferenceLayer } from "../services"
import { modelProviderModuleOf } from "./directory"

const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.signature`
const options = { provider: "codex" as const, client: { apiKey: Redacted.make(token), apiUrl: "https://fixture.invalid/codex" }, model: { model: "gpt-5.2-codex" } }
const auth = { credentials: Effect.succeed({ accessToken: "rotated-token", accountId: "account" }) }
const toolkit = Toolkit.make(Tool.dynamic("read", { parameters: Schema.Struct({ path: Schema.String }) }))
const frames = providerEvents("openai", false).map((event, sequence_number) => `data: ${JSON.stringify({ sequence_number, ...event })}\n\n`).join("")

for (const mode of ["stream", "complete"] as const) {
  test(`Codex ${mode} preserves tools, reasoning, usage, and renewed authentication`, async () => {
    const requests: Array<Record<string, unknown>> = []
    const http = HttpClient.make((request, url) => Effect.sync(() => {
      expect(url.toString()).toBe("https://fixture.invalid/codex/responses")
      expect(request.headers.authorization).toBe("Bearer rotated-token")
      expect(request.headers["chatgpt-account-id"]).toBe("account")
      if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON")
      requests.push(JSON.parse(new TextDecoder().decode(request.body.body)))
      return HttpClientResponse.fromWeb(request, new Response(frames, { headers: { "content-type": "text/event-stream" } }))
    }))
    const layer = createProviderLayer(auth)(options).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)))
    const input = { prompt: Prompt.make([{ role: "system", content: "Keep answers short." }, { role: "user", content: "Read the files" }]), toolkit, disableToolCallResolution: true as const }
    const response = mode === "stream"
      ? await Effect.runPromise(LanguageModel.streamText(input).pipe(Stream.runCollect, Effect.provide(layer)))
      : (await Effect.runPromise(LanguageModel.generateText(input).pipe(Effect.provide(layer)))).content
    expect(response.filter(part => part.type === "tool-call").map(part => part.id)).toEqual(["a", "b", "c"])
    expect(response.find(part => part.type === "finish")?.usage.outputTokens.total).toBe(5)
    expect(requests[0]).toMatchObject({ stream: true, store: false, instructions: "Keep answers short." })
    expect(requests[0]?.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Read the files" }] }])
    expect(requests[0]?.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "read" })]))
    const continuation = Prompt.fromResponseParts(response)
    await Effect.runPromise(LanguageModel.generateText({ ...input, prompt: Prompt.concat(input.prompt, continuation) }).pipe(Effect.provide(layer)))
    expect(requests[1]?.input).toEqual(expect.arrayContaining(reasoning))
  })
}

test("Codex static access tokens use the optional provider loader", async () => {
  const http = HttpClient.make(request => Effect.sync(() => {
    expect(request.headers.authorization).toBe(`Bearer ${token}`)
    expect(request.headers["chatgpt-account-id"]).toBe("account")
    return HttpClientResponse.fromWeb(request, new Response(frames))
  }))
  await Effect.runPromise(LanguageModel.generateText({ prompt: "Read", toolkit, disableToolCallResolution: true as const }).pipe(
    Effect.provide(loadProvider(options)), Effect.provideService(HttpClient.HttpClient, http)
  ))
  expect(modelProviderModuleOf("codex", "openai-responses")).toBe("codex")
  expect(modelProviderModuleOf("openai", "openai-responses")).toBe("openai")
  expect(() => credentialsFromAccessToken("private-invalid-token")).toThrow("Invalid Codex credentials")
})

test("Codex exposes unsupported output limits and permits rejection", async () => {
  const http = HttpClient.make(() => Effect.die("No request is permitted"))
  const configured = { ...options, endpoint: options.client.apiUrl, maxOutputTokens: 10 }
  const layer = inferenceLayer(configured, createProviderLayer(auth, { outputLimit: "reject" })).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)))
  const settings = await Effect.runPromise(BindingSettings.pipe(Effect.provide(layer)))
  expect(settings.outputTokenLimitEnforcement).toBe("unsupported")
  expect(settings.policy.maxOutputTokens).toBe(10)
  expect(settings.protocol).toBe("openai-responses")
  await expect(Effect.runPromise(LanguageModel.generateText({ prompt: "Hello" }).pipe(Effect.provide(layer)))).rejects.toThrow("cannot enforce")
})

test("Codex refuses late system messages before sending credentials", async () => {
  const http = HttpClient.make(() => Effect.die("No request is permitted"))
  await expect(Effect.runPromise(LanguageModel.generateText({ prompt: Prompt.make([
    { role: "user", content: "Hello" }, { role: "system", content: "Late instructions" }
  ]) }).pipe(Effect.provide(providerLayer(options)), Effect.provideService(HttpClient.HttpClient, http)))).rejects.toThrow("System messages must precede")
})

for (const status of [401, 429, 503]) {
  test(`Codex preserves HTTP ${status} in the model error`, async () => {
    const http = HttpClient.make(request => Effect.succeed(HttpClientResponse.fromWeb(request, new Response("Rejected", { status }))))
    const result = await Effect.runPromise(LanguageModel.generateText({ prompt: "Hello" }).pipe(
      Effect.provide(providerLayer(options)), Effect.provideService(HttpClient.HttpClient, http), Effect.result
    ))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(JSON.stringify(result.failure)).toContain(String(status))
  })
}

test("Codex complete responses reject a stream without a terminal event", async () => {
  const http = HttpClient.make(request => Effect.succeed(HttpClientResponse.fromWeb(request, new Response("data: [DONE]\n\n"))))
  await expect(Effect.runPromise(LanguageModel.generateText({ prompt: "Hello" }).pipe(
    Effect.provide(providerLayer(options)), Effect.provideService(HttpClient.HttpClient, http)
  ))).rejects.toThrow("without a terminal response")
})

test("Codex warns before omitting a requested output limit", async () => {
  const warnings: Array<ReadonlyArray<unknown>> = []
  const http = HttpClient.make(request => Effect.sync(() => {
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.join(" ")).toContain("max_output_tokens=10")
    if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON")
    expect(JSON.parse(new TextDecoder().decode(request.body.body))).not.toHaveProperty("max_output_tokens")
    return HttpClientResponse.fromWeb(request, new Response(frames))
  }))
  await Effect.runPromise(Effect.gen(function* () {
    const console = yield* Console.Console
    return yield* LanguageModel.generateText({ prompt: "Read", toolkit, disableToolCallResolution: true }).pipe(
      Effect.provide(inferenceLayer({ ...options, endpoint: options.client.apiUrl, maxOutputTokens: 10 }, providerLayer)),
      Effect.provideService(Console.Console, { ...console, warn: (...args) => { warnings.push(args) } })
    )
  }).pipe(Effect.provideService(HttpClient.HttpClient, http)))
})

test("model locks select Codex and expose its output limit capability", async () => {
  const definitions = modelLockOf({ schema: 2,
    providers: { codex: { protocol: "openai-responses", baseUrl: "https://fixture.invalid", env: ["TOKEN"] } },
    models: [{ provider: "codex", model_id: "test-model", contextWindowTokens: 32000 }]
  })
  const lock = modelLockService(definitions, { allow: "*", default: { provider: "codex", model_id: "test-model" } })
  const settings = await Effect.runPromise(modelSettingsFor().pipe(Effect.provide(
    modelLayer({ credentials: { TOKEN: token } }).pipe(Layer.provide(Layer.succeed(ModelLock, lock)))
  )))
  expect(settings).toMatchObject({ provider: "codex", protocol: "openai-responses", outputTokenLimitEnforcement: "unsupported" })
})

test("Codex request cancellation interrupts the upstream request", async () => {
  let interrupted = false
  await Effect.runPromise(Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const http = HttpClient.make(() => Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Effect.never), Effect.onInterrupt(() => Effect.sync(() => { interrupted = true }))
    ))
    const fiber = yield* LanguageModel.generateText({ prompt: "Hello" }).pipe(
      Effect.provide(providerLayer(options)), Effect.provideService(HttpClient.HttpClient, http), Effect.forkChild
    )
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
  }))
  expect(interrupted).toBe(true)
})

test("Codex complete streams support structured output", async () => {
  const response = { id: "response", model: "gpt-5.2-codex", created_at: 1, status: "completed", output: [
    { id: "message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{"greeting":"Hello"}', annotations: [] }] }
  ], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } }
  const http = HttpClient.make(request => Effect.succeed(HttpClientResponse.fromWeb(request,
    new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`)
  )))
  const result = await Effect.runPromise(LanguageModel.generateObject({ prompt: "Greet me", schema: Schema.Struct({ greeting: Schema.String }) }).pipe(
    Effect.provide(providerLayer(options)), Effect.provideService(HttpClient.HttpClient, http)
  ))
  expect(result.value).toEqual({ greeting: "Hello" })
})

test("Codex model discovery uses account credentials and a configurable client version", async () => {
  const http = HttpClient.make((request, url) => Effect.sync(() => {
    expect(url.toString()).toBe("https://fixture.invalid/codex/models?client_version=0.162.0")
    expect(request.headers.authorization).toBe("Bearer rotated-token")
    expect(request.headers["chatgpt-account-id"]).toBe("account")
    return HttpClientResponse.fromWeb(request, Response.json({ models: [
      { slug: "available-model", visibility: "list" }, { slug: "hidden-model", visibility: "hide" }
    ] }))
  }))
  const models = await Effect.runPromise(listModels(auth, { baseUrl: "https://fixture.invalid/codex", clientVersion: "0.162.0" }).pipe(
    Effect.provideService(HttpClient.HttpClient, http)
  ))
  expect(models.map(model => model.slug)).toEqual(["available-model", "hidden-model"])
})

test("Codex model discovery respects its timeout override", async () => {
  const http = HttpClient.make(() => Effect.never)
  const result = await Effect.runPromise(listModels(auth, { requestMs: 1 }).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.result))
  expect(result._tag).toBe("Failure")
})
