import { Config, Effect, Redacted } from "effect"
import type { InferenceProvider } from "../infer"
import { environment, environmentNumber } from "./environment"
import { openAiChatInference } from "./openai-chat"

export interface VercelGatewayInferenceOptions {
  readonly apiKey?: string
  readonly model?: string
  readonly contextWindow?: number
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
}

// What each model accepts, as the gateway publishes it. The context window belongs to the model, so
// it is read from the model rather than assumed: a figure written here would be wrong for every
// model it was not measured against, and it would decide when compaction fires.
//
// One catalog per gateway per process, shared by every provider built against it, because the
// answer is the same for all of them and none of it is a secret. A read that fails is dropped from
// the table so the next provider tries again rather than inheriting one bad morning.
const catalogs = new Map<string, Promise<ReadonlyMap<string, number>>>()

interface CatalogEntry {
  readonly id?: unknown
  readonly context_window?: unknown
}

const readCatalog = async (
  baseUrl: string,
  call: typeof fetch
): Promise<ReadonlyMap<string, number>> => {
  const response = await call(`${baseUrl}/models`)
  if (!response.ok) {
    throw new Error(`the gateway model catalog returned HTTP ${response.status}`)
  }
  const body = (await response.json()) as { readonly data?: ReadonlyArray<CatalogEntry> }
  return new Map(
    (body.data ?? []).flatMap((entry) =>
      typeof entry.id === "string" && typeof entry.context_window === "number"
        ? ([[entry.id, entry.context_window]] as ReadonlyArray<readonly [string, number]>)
        : []
    )
  )
}

const catalogOf = (baseUrl: string, call: typeof fetch): Promise<ReadonlyMap<string, number>> => {
  const held = catalogs.get(baseUrl)
  if (held !== undefined) return held
  const reading = readCatalog(baseUrl, call).catch((error: unknown) => {
    catalogs.delete(baseUrl)
    throw error
  })
  catalogs.set(baseUrl, reading)
  return reading
}

// A catalog this side could not read leaves the window unknown. It is not a reason to fail the
// turn: the request still reaches the gateway, which knows its own limit and says so.
const discoverContextWindow = (baseUrl: string, call: typeof fetch, model: string) =>
  Effect.tryPromise({
    try: () => catalogOf(baseUrl, call),
    catch: (error) => (error instanceof Error ? error : new Error(String(error)))
  }).pipe(
    Effect.map((catalog) => catalog.get(model)),
    Effect.catch(() => Effect.succeed(undefined)),
    Effect.catchDefect(() => Effect.succeed(undefined))
  )

// The key is the one secret here, so it is the one setting read as a `Config`: it is resolved where
// it is used and stays redacted until the request carries it. The model is read at construction
// because `state` reports it synchronously, and it is not a secret.
export const vercelGatewayInference = (
  options: VercelGatewayInferenceOptions = {}
): InferenceProvider => {
  const configured = options.apiKey === "" ? undefined : options.apiKey
  const apiKey =
    configured === undefined
      ? Config.redacted("AI_GATEWAY_API_KEY")
      : Config.succeed(Redacted.make(configured))
  const model = options.model ?? environment("AI_GATEWAY_MODEL") ?? "anthropic/claude-sonnet-4.6"
  const contextWindow = options.contextWindow ?? environmentNumber("AI_GATEWAY_CONTEXT_WINDOW")
  const baseUrl = (options.baseUrl ?? "https://ai-gateway.vercel.sh/v1").replace(/\/$/, "")
  const call = options.fetch ?? fetch
  return openAiChatInference({
    id: `vercel-ai-gateway:${model}`,
    provider: "vercel-ai-gateway",
    model,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    discoverContextWindow: discoverContextWindow(baseUrl, call, model),
    endpoint: `${baseUrl}/chat/completions`,
    apiKey,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  })
}
