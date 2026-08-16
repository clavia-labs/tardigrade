import { Config, Duration, Effect, Redacted } from "effect"
import type { InferenceProvider } from "../infer"
import { environment, environmentNumber } from "./environment"
import { openAiChatInference, transport } from "./openai-chat"

export interface VercelGatewayInferenceOptions {
  readonly apiKey?: string
  readonly model?: string
  // What the model accepts. Supplying it builds the provider here and now. Leaving it out asks the
  // gateway, which is why the constructor that has to ask returns an effect.
  readonly contextWindow?: number
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
  // The transport settings, forwarded rather than fixed here. A gateway in front of a reasoning
  // model answers on a different scale from one in front of a small one, and the caller is the only
  // one who knows which they have.
  readonly headers?: Readonly<Record<string, string>>
  readonly retries?: number
  readonly timeout?: Duration.Input
  readonly maxOutputTokens?: number
}

// What each model accepts, as the gateway publishes it. The context window belongs to the model, so
// it is read from the model rather than assumed: a figure written here would be wrong for every
// model it was not measured against, and it decides when compaction fires.
//
// One catalog per gateway per process, shared by every provider built against it, because the
// answer is the same for all of them and none of it is a secret. A read that fails is dropped from
// the table so the next construction tries again rather than inheriting one bad morning.
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

const settings = (options: VercelGatewayInferenceOptions) => {
  const configured = options.apiKey === "" ? undefined : options.apiKey
  return {
    apiKey:
      configured === undefined
        ? Config.redacted("AI_GATEWAY_API_KEY")
        : Config.succeed(Redacted.make(configured)),
    model: options.model ?? environment("AI_GATEWAY_MODEL") ?? "anthropic/claude-sonnet-4.6",
    baseUrl: (options.baseUrl ?? "https://ai-gateway.vercel.sh/v1").replace(/\/$/, "")
  }
}

const build = (
  options: VercelGatewayInferenceOptions,
  model: string,
  baseUrl: string,
  apiKey: Config.Config<Redacted.Redacted<string>>,
  contextWindow: number
): InferenceProvider =>
  openAiChatInference({
    id: `vercel-ai-gateway:${model}`,
    provider: "vercel-ai-gateway",
    model,
    contextWindow,
    endpoint: `${baseUrl}/chat/completions`,
    apiKey,
    ...transport(options)
  })

// The key is the one secret here, so it is the one setting read as a `Config`: it is resolved where
// it is used and stays redacted until the request carries it. The model is read at construction
// because `state` reports it synchronously, and it is not a secret.
//
// The window decides the shape of this call. Stating it builds a provider here, with no network and
// no effect. Leaving it out means the gateway has to be asked, and asking is an effect, so the
// answer arrives in one. Nothing in between: a provider always holds a real number, because a
// machine guard folds over what this reports and a fold can not wait for a fetch.
export function vercelGatewayInference(
  options: VercelGatewayInferenceOptions & { readonly contextWindow: number }
): InferenceProvider
export function vercelGatewayInference(
  options?: VercelGatewayInferenceOptions
): Effect.Effect<InferenceProvider, Error>
export function vercelGatewayInference(
  options: VercelGatewayInferenceOptions = {}
): InferenceProvider | Effect.Effect<InferenceProvider, Error> {
  const { apiKey, model, baseUrl } = settings(options)
  const stated = options.contextWindow ?? environmentNumber("AI_GATEWAY_CONTEXT_WINDOW")
  if (stated !== undefined) return build(options, model, baseUrl, apiKey, stated)
  const call = options.fetch ?? fetch
  return Effect.gen(function* () {
    const catalog = yield* Effect.tryPromise({
      try: () => catalogOf(baseUrl, call),
      catch: (error) =>
        new Error(
          `vercel-ai-gateway could not read its model catalog: ${
            error instanceof Error ? error.message : String(error)
          }. Pass contextWindow to state what ${model} accepts.`
        )
    })
    const published = catalog.get(model)
    if (published === undefined) {
      return yield* Effect.fail(
        new Error(
          `vercel-ai-gateway publishes no context window for "${model}". Pass contextWindow to ` +
            "state what it accepts, or name a model the gateway lists."
        )
      )
    }
    return build(options, model, baseUrl, apiKey, published)
  })
}
