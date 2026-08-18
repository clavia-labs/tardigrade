import { createGateway } from "@ai-sdk/gateway"
import { Duration, Effect } from "effect"
import type { ProviderOptions } from "@ai-sdk/provider-utils"
import type { Effort, InferenceProvider, ModelPricing } from "../infer"
import { environment, environmentNumber } from "./environment"
import { modelInference } from "./model"

export interface VercelGatewayInferenceOptions {
  readonly apiKey?: string
  readonly model?: string
  // What the model accepts. Supplying it builds the provider here and now. Leaving it out asks the
  // gateway, which is why the constructor that has to ask returns an effect.
  readonly contextWindow?: number
  // The gateway's origin. Two paths hang off it and they are not the same surface: the SDK speaks
  // its own protocol under `/v4/ai`, and the catalog that publishes context windows is the
  // OpenAI-compatible one under `/v1`. Naming the origin is what keeps those from being confused
  // for each other.
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
  // The transport settings, forwarded rather than fixed here. A gateway in front of a reasoning
  // model answers on a different scale from one in front of a small one, and the caller is the only
  // one who knows which they have.
  readonly headers?: Readonly<Record<string, string>>
  readonly retries?: number
  readonly timeout?: Duration.Input
  readonly maxOutputTokens?: number
  readonly temperature?: number
  readonly reasoning?: Effort
  readonly pricing?: ModelPricing
  readonly providerOptions?: ProviderOptions
  // Which upstream providers may serve this model. Absent leaves the routing to the gateway, because
  // where a request runs is a deployment's decision rather than this framework's. It has one
  // consequence worth knowing: a route that answers with several tool calls at once fails a harness
  // that runs one at a time, and the failure names this option.
  readonly routes?: ReadonlyArray<string>
}

// What each model accepts, as the gateway publishes it. The context window belongs to the model, so
// it is read from the model rather than assumed: a figure written here would be wrong for every
// model it was not measured against, and it decides when compaction fires.
//
// This is the one request in the package that is not the SDK's to make. The SDK's own metadata
// carries a model's price but not its context window, and the framework can not invent a window, so
// the catalog is read where it publishes one.
//
// One catalog per gateway per process, shared by every provider built against it, because the
// answer is the same for all of them and none of it is a secret. A read that fails is dropped from
// the table so the next construction tries again rather than inheriting one bad morning.
interface Limits {
  readonly contextWindow: number
  readonly maxOutputTokens?: number
  readonly pricing?: ModelPricing
}

const catalogs = new Map<string, Promise<ReadonlyMap<string, Limits>>>()

interface CatalogEntry {
  readonly id?: unknown
  readonly context_window?: unknown
  readonly max_tokens?: unknown
  readonly pricing?: {
    readonly input?: unknown
    readonly output?: unknown
  }
}

const pricingOf = (entry: CatalogEntry): ModelPricing | undefined => {
  const promptUsdPerToken = Number(entry.pricing?.input)
  const completionUsdPerToken = Number(entry.pricing?.output)
  if (!Number.isFinite(promptUsdPerToken) || !Number.isFinite(completionUsdPerToken)) return undefined
  return { promptUsdPerToken, completionUsdPerToken }
}

const readCatalog = async (
  baseUrl: string,
  call: typeof fetch
): Promise<ReadonlyMap<string, Limits>> => {
  const response = await call(`${baseUrl}/models`)
  if (!response.ok) {
    throw new Error(`the gateway model catalog returned HTTP ${response.status}`)
  }
  const body = (await response.json()) as { readonly data?: ReadonlyArray<CatalogEntry> }
  return new Map(
    (body.data ?? []).flatMap((entry) =>
      typeof entry.id === "string" && typeof entry.context_window === "number"
        ? ([
            [
              entry.id,
              {
                contextWindow: entry.context_window,
                ...(typeof entry.max_tokens === "number"
                  ? { maxOutputTokens: entry.max_tokens }
                  : {}),
                ...(pricingOf(entry) === undefined ? {} : { pricing: pricingOf(entry) })
              }
            ]
          ] as ReadonlyArray<readonly [string, Limits]>)
        : []
    )
  )
}

const catalogOf = (baseUrl: string, call: typeof fetch): Promise<ReadonlyMap<string, Limits>> => {
  const held = catalogs.get(baseUrl)
  if (held !== undefined) return held
  const reading = readCatalog(baseUrl, call).catch((error: unknown) => {
    catalogs.delete(baseUrl)
    throw error
  })
  catalogs.set(baseUrl, reading)
  return reading
}

const ORIGIN = "https://ai-gateway.vercel.sh"

const settings = (options: VercelGatewayInferenceOptions) => {
  const configured = options.apiKey === "" ? undefined : options.apiKey
  const origin = (options.baseUrl ?? ORIGIN).replace(/\/$/, "")
  return {
    apiKey: configured,
    model: options.model ?? environment("AI_GATEWAY_MODEL") ?? "anthropic/claude-sonnet-4.6",
    origin,
    modelUrl: `${origin}/v4/ai`,
    catalogUrl: `${origin}/v1`
  }
}

// Every model this gateway serves reaches it the same way. The SDK resolves a `provider/model`
// identifier against the gateway and speaks whichever wire format the model's own maker built,
// including the reasoning state that a later request has to carry back. One path per gateway is what
// keeps a setting from meaning one thing for a Claude model and another for a Gemini one.
const build = (
  options: VercelGatewayInferenceOptions,
  model: string,
  modelUrl: string,
  apiKey: string | undefined,
  contextWindow: number,
  publishedOutputTokens?: number,
  publishedPricing?: ModelPricing
): InferenceProvider => {
  const gateway = createGateway({
    // The SDK reads `AI_GATEWAY_API_KEY` when nobody passes a key, which is the same source the
    // gateway documents, so an absent key here is deferred to it rather than resolved to an empty
    // one that would fail as a refusal on the first call.
    ...(apiKey === undefined ? {} : { apiKey }),
    baseURL: modelUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.headers === undefined ? {} : { headers: options.headers })
  })
  const pricing = options.pricing ?? publishedPricing
  const ceiling = options.maxOutputTokens ?? publishedOutputTokens
  const routed =
    options.routes === undefined ? undefined : { gateway: { only: [...options.routes] } }
  return modelInference({
    id: `vercel-ai-gateway:${model}`,
    provider: "vercel-ai-gateway",
    model,
    contextWindow,
    languageModel: gateway(model),
    ...(options.retries === undefined ? {} : { retries: options.retries }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
    // The caller's ceiling, then the model's own. Absent leaves the provider's default for the
    // model, and the published figure is why a model that can write 128,000 tokens is allowed to.
    ...(ceiling === undefined ? {} : { maxOutputTokens: ceiling }),
    ...(pricing === undefined ? {} : { pricing }),
    ...(routed === undefined && options.providerOptions === undefined
      ? {}
      : { providerOptions: { ...options.providerOptions, ...routed } })
  })
}

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
  const { apiKey, model, modelUrl, catalogUrl } = settings(options)
  const stated = options.contextWindow ?? environmentNumber("AI_GATEWAY_CONTEXT_WINDOW")
  if (stated !== undefined) return build(options, model, modelUrl, apiKey, stated)
  const call = options.fetch ?? fetch
  return Effect.gen(function* () {
    const catalog = yield* Effect.tryPromise({
      try: () => catalogOf(catalogUrl, call),
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
    // A construction that can not settle a required figure throws, and this one runs inside an
    // effect, so the throw becomes the effect's failure rather than a defect the caller can not
    // catch beside the other construction failures here.
    return yield* Effect.try({
      try: () =>
        build(
          options,
          model,
          modelUrl,
          apiKey,
          published.contextWindow,
          published.maxOutputTokens,
          published.pricing
        ),
      catch: (error) => (error instanceof Error ? error : new Error(String(error)))
    })
  })
}
