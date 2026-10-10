import { Console, Effect, Layer, Redacted, Schema, Stream } from "effect"
import { OpenAiClient, OpenAiLanguageModel, OpenAiSchema } from "@tardie/ai-openai"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { unknownModelError } from "../error"
import { requestKeys, type ProviderLayer } from "./layer"
import { validatedConfig } from "./options"
import { credentialsFromAccessToken, type CodexCredentials } from "./codex-auth"

export const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex"
export const DEFAULT_OUTPUT_LIMIT = "warn" as const
export const MODEL_LIST_DEFAULTS = { baseUrl: DEFAULT_BASE_URL, clientVersion: "0.162.0", requestMs: 30_000 }
const modelsSchema = Schema.Struct({ models: Schema.Array(Schema.Struct({ slug: Schema.NonEmptyString, visibility: Schema.optional(Schema.String), context_window: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))) })) })

// listModels reads account-specific model names without selecting a default (codex.test.ts).
export const listModels = (auth: CodexCredentials["Service"], overrides: Partial<typeof MODEL_LIST_DEFAULTS> = {}) => {
  const options = { ...MODEL_LIST_DEFAULTS, ...overrides }
  return Effect.gen(function* () {
    const credentials = yield* auth.credentials
    const http = yield* HttpClient.HttpClient
    const response = yield* http.execute(HttpClientRequest.get(`${options.baseUrl}/models`).pipe(
      HttpClientRequest.setUrlParam("client_version", options.clientVersion),
      HttpClientRequest.setHeaders({ authorization: `Bearer ${credentials.accessToken}`, "chatgpt-account-id": credentials.accountId, originator: "codex_cli_rs" })
    ))
    if (response.status < 200 || response.status >= 300) return yield* unknownModelError(`Codex model discovery returns HTTP ${response.status}`)
    const body = yield* response.json
    return (yield* Schema.decodeUnknownEffect(modelsSchema)(body)).models
  }).pipe(Effect.timeout(options.requestMs), Effect.mapError(unknownModelError))
}

export interface CodexOptions {
  readonly outputLimit?: "warn" | "reject"
}

// createProviderLayer shares host-owned credentials across model bindings (codex.test.ts).
export const createProviderLayer = (auth?: CodexCredentials["Service"], policy: CodexOptions = {}): ProviderLayer => options => {
  if (options.provider !== "codex") throw new Error(`The Codex layer cannot serve ${options.provider}; supply the matching providerLayer`)
  const clientLayer = Layer.effect(OpenAiClient.OpenAiClient, Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const base = yield* OpenAiClient.make({ ...options.client, apiUrl: options.client.apiUrl ?? DEFAULT_BASE_URL })
    const createResponseStream: OpenAiClient.Service["createResponseStream"] = request => Effect.gen(function* () {
      const input = request.input
      if (!Array.isArray(input)) return yield* unknownModelError("Codex requires an input array")
      const instructions = [request.instructions ?? ""]
      let conversation = false
      const filtered: typeof input = []
      for (const item of input) {
        if (!("role" in item) || (item.role !== "system" && item.role !== "developer")) { conversation = true; filtered.push(item); continue }
        if (conversation) return yield* unknownModelError("System messages must precede the conversation")
        if (typeof item.content === "string") instructions.push(item.content)
        else {
          for (const part of item.content) {
            if (part.type !== "input_text") return yield* unknownModelError("Codex system instructions require text")
            instructions.push(part.text)
          }
        }
      }
      if (request.max_output_tokens != null) {
        if ((policy.outputLimit ?? DEFAULT_OUTPUT_LIMIT) === "reject") return yield* unknownModelError("Codex cannot enforce max_output_tokens")
        yield* Console.warn(`Codex does not enforce max_output_tokens=${request.max_output_tokens}; the provider omits this field.`)
      }
      const credentials = yield* auth?.credentials ?? Effect.try({
        try: () => credentialsFromAccessToken(options.client.apiKey === undefined ? "" : Redacted.value(options.client.apiKey)),
        catch: unknownModelError
      })
      const client = yield* OpenAiClient.make({ ...options.client, apiKey: Redacted.make(credentials.accessToken), apiUrl: options.client.apiUrl ?? DEFAULT_BASE_URL,
        transformClient: http => requestKeys((options.client.transformClient?.(http) ?? http)).pipe(
          HttpClient.mapRequest(request => HttpClientRequest.setHeaders(request, { "chatgpt-account-id": credentials.accountId, originator: "codex_cli_rs" }))
        )
      })
      const { max_output_tokens: _limit, ...body } = request
      return yield* client.createResponseStream({ ...body, input: filtered, instructions: instructions.filter(Boolean).join("\n\n"), store: false })
    }).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.mapError(unknownModelError))
    return { ...base, createResponseStream,
      createResponse: request => Effect.gen(function* () {
        const [response, stream] = yield* createResponseStream(request)
        const completed = yield* Stream.runFoldEffect(stream, () => undefined as OpenAiSchema.Response | undefined, (value, event) => {
          if (event.type === "response.failed") return Effect.fail(unknownModelError("Codex response failed"))
          return event.type === "response.completed" || event.type === "response.incomplete"
            ? Schema.decodeUnknownEffect(OpenAiSchema.Response)(event.response).pipe(Effect.mapError(unknownModelError))
            : Effect.succeed(value)
        })
        if (completed === undefined) return yield* unknownModelError("Codex stream ends without a terminal response")
        return [completed, response] as const
      }),
      createEmbedding: () => Effect.fail(unknownModelError("Codex does not support embeddings"))
    } satisfies OpenAiClient.Service
  }))
  return OpenAiLanguageModel.layer({ ...options.model, config: { ...validatedConfig(OpenAiLanguageModel.ModelConfigSchema, options.model.config, options.unvalidatedConfig), store: false } }).pipe(Layer.provide(clientLayer))
}

export const providerLayer: ProviderLayer = createProviderLayer()
