import { Config, Duration, Effect, Redacted } from "effect"
import type { InferenceProvider } from "../infer"
import { anthropicMessagesInference, type ThinkingEffort } from "./anthropic-messages"
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
  // How much an Anthropic model thinks before it answers. Ignored by a model on the
  // OpenAI-compatible surface, which takes its reasoning settings from the gateway's own default.
  readonly effort?: ThinkingEffort
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
// One catalog per gateway per process, shared by every provider built against it, because the
// answer is the same for all of them and none of it is a secret. A read that fails is dropped from
// the table so the next construction tries again rather than inheriting one bad morning.
// The catalog publishes an output ceiling beside the window, and the Messages API requires one in
// every request, so it is read from the model for the same reason the window is.
interface Limits {
  readonly contextWindow: number
  readonly maxOutputTokens?: number
}

const catalogs = new Map<string, Promise<ReadonlyMap<string, Limits>>>()

interface CatalogEntry {
  readonly id?: unknown
  readonly context_window?: unknown
  readonly max_tokens?: unknown
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
                  : {})
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

// An Anthropic model reaches this gateway through two surfaces, and they are not equivalent. The
// OpenAI-compatible one returns no thinking state for the current models, so a turn's reasoning ends
// with the turn that made it. The Messages surface returns thinking blocks with their signatures, so
// the model builds on what it already worked out. A model is asked for on the surface its maker
// built for it.
const isAnthropic = (model: string) => model.startsWith("anthropic/")

// The Messages API refuses a request that states no ceiling on the answer, so one is always sent.
// The model publishes its own, and this is what is left when nobody asked the catalog: a caller who
// states the context window has said they know the model's limits, and this call makes no network
// request to check. It is the lowest ceiling any Claude model accepts, because a figure above what
// the model allows is refused on every request rather than on a long one. A turn that reaches it
// fails and names `maxOutputTokens`, so a ceiling too low for the work says so.
const SAFE_OUTPUT_TOKENS = 8192

const build = (
  options: VercelGatewayInferenceOptions,
  model: string,
  baseUrl: string,
  apiKey: Config.Config<Redacted.Redacted<string>>,
  contextWindow: number,
  publishedOutputTokens?: number
): InferenceProvider => {
  if (isAnthropic(model)) {
    return anthropicMessagesInference({
      id: `vercel-ai-gateway:${model}`,
      provider: "vercel-ai-gateway",
      model,
      contextWindow,
      endpoint: `${baseUrl}/messages`,
      apiKey,
      ...transport(options),
      // The caller's ceiling, then the model's own, then the floor below. The published figure is
      // why a model that can write 128,000 tokens is allowed to, rather than being held to the one
      // number that would have been safe for every model at once.
      maxOutputTokens: options.maxOutputTokens ?? publishedOutputTokens ?? SAFE_OUTPUT_TOKENS,
      ...(options.effort === undefined ? {} : { effort: options.effort }),
      ...(options.routes === undefined
        ? {}
        : { body: { providerOptions: { gateway: { only: options.routes } } } })
    })
  }
  return openAiChatInference({
    id: `vercel-ai-gateway:${model}`,
    provider: "vercel-ai-gateway",
    model,
    contextWindow,
    endpoint: `${baseUrl}/chat/completions`,
    apiKey,
    ...transport(options)
  })
}

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
    // A construction that can not settle a required figure throws, and this one runs inside an
    // effect, so the throw becomes the effect's failure rather than a defect the caller can not
    // catch beside the other construction failures here.
    return yield* Effect.try({
      try: () =>
        build(
          options,
          model,
          baseUrl,
          apiKey,
          published.contextWindow,
          published.maxOutputTokens
        ),
      catch: (error) => (error instanceof Error ? error : new Error(String(error)))
    })
  })
}
