import * as Prompt from "effect/ai/Prompt"
import { isPromptBoundary } from "./prompt"

export type CacheProvider = "anthropic" | "openrouter" | "openai"

export interface PromptCaching {
  readonly maxCheckpoints: number
  readonly conversation: boolean
  readonly provider?: CacheProvider
}

export const DEFAULT_PROMPT_CACHING: Readonly<PromptCaching> = Object.freeze({ maxCheckpoints: 4, conversation: true })

export interface CacheSettings extends PromptCaching {
  readonly provider: CacheProvider
  readonly manual: boolean
}

// promptCachingOf enables checkpoint placement for known adapter and model combinations; provider overrides declare custom endpoint support.
export function promptCachingOf(adapter: string, model: string, config: object | undefined, options?: false | Partial<PromptCaching>): CacheSettings | undefined {
  if (options === false) return undefined
  const provider = options?.provider ?? (adapter === "anthropic" ? "anthropic"
    : adapter === "openai" && supportsOpenAiCheckpoints(model) ? "openai"
    : adapter === "openrouter" && /^(?:~)?(?:anthropic\/|google\/gemini-(?:2\.5|[3-9]))/.test(model) ? "openrouter" : undefined)
  if (provider === undefined) return undefined
  if (provider !== adapter && !(provider === "openai" && adapter === "codex")) {
    throw new Error(`promptCache.provider ${provider} is not encoded by the ${adapter} adapter`)
  }
  const policy = { ...DEFAULT_PROMPT_CACHING, ...options }
  if (!Number.isSafeInteger(policy.maxCheckpoints) || policy.maxCheckpoints < 0 || policy.maxCheckpoints > DEFAULT_PROMPT_CACHING.maxCheckpoints) {
    throw new Error(`promptCache.maxCheckpoints must be an integer from 0 to ${DEFAULT_PROMPT_CACHING.maxCheckpoints}`)
  }
  return { provider, maxCheckpoints: policy.maxCheckpoints, conversation: policy.conversation,
    manual: config !== undefined && ("cache_control" in config || "prompt_cache_options" in config) }
}

function supportsOpenAiCheckpoints(model: string): boolean {
  const version = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(model)
  return version !== null && (Number(version[1]) > 5 || Number(version[1]) === 5 && Number(version[2] ?? 0) >= 6)
}

export type CacheCheckpoint = {
  readonly message: number
  readonly part?: number
}

export interface CachePlan {
  readonly mode: "automatic" | "manual"
  readonly checkpoints: readonly CacheCheckpoint[]
  readonly omittedSystem: number
}

// planPromptCache places checkpoints at source boundaries without changing prompt text or order; explicit native controls own placement.
export function planPromptCache(messages: readonly Prompt.Message[], settings: CacheSettings): { readonly messages: readonly Prompt.Message[]; readonly plan: CachePlan } {
  const implicit = settings.provider === "openai"
  const field = implicit ? "promptCacheBreakpoint" : "cacheControl"
  const controlled = (options: Prompt.ProviderOptions) => {
    const native = options[settings.provider]
    return native !== null && typeof native === "object" && field in native
  }
  if (settings.manual || messages.some(message => controlled(message.options) || message.role !== "system" && message.content.some(part => controlled(part.options)))) {
    return { messages, plan: { mode: "manual", checkpoints: [], omittedSystem: 0 } }
  }
  const system = messages.flatMap((message, index) => message.role === "system" && isPromptBoundary(message.options) ? [{ message: index }] : [])
  if (system.length === 0) {
    const index = messages.findLastIndex(message => message.role === "system")
    if (index >= 0) system.push({ message: index })
  }
  const budget = Math.max(0, settings.maxCheckpoints - (implicit ? 1 : 0))
  const tail = settings.conversation && !implicit ? conversationTail(messages) : undefined
  const checkpoints: CacheCheckpoint[] = system.slice(0, budget > 1 && tail ? budget - 1 : budget)
  if (tail && checkpoints.length < budget) checkpoints.push(tail)
  const control: Record<string, string> = implicit ? { mode: "explicit" } : { type: "ephemeral" }
  const optionsOf = (options: Prompt.ProviderOptions): Prompt.ProviderOptions => {
    const native = options[settings.provider]
    return { ...options, [settings.provider]: { ...(native !== null && typeof native === "object" && !Array.isArray(native) ? native : {}), [field]: control } }
  }
  return {
    messages: messages.map((message, index) => {
      const checkpoint = checkpoints.find(value => value.message === index)
      if (!checkpoint) return message
      if (message.role === "system") return Prompt.makeMessage("system", { content: message.content, options: optionsOf(message.options) })
      const markPart = <Part extends Prompt.Part>(part: Part, index: number): Part => index === checkpoint.part ? { ...part, options: optionsOf(part.options) } : part
      if (message.role === "user") return Prompt.makeMessage("user", {
        content: message.content.map(markPart),
        options: settings.provider === "openrouter" && message.content.length === 1 && message.content[0]?.type === "text"
          ? optionsOf(message.options) : message.options,
      })
      if (message.role === "assistant") return Prompt.makeMessage("assistant", { content: message.content.map(markPart), options: message.options })
      return Prompt.makeMessage("tool", { content: message.content.map(markPart), options: message.options })
    }),
    plan: { mode: "automatic", checkpoints, omittedSystem: system.length - checkpoints.filter(value => value.part === undefined).length },
  }
}

function conversationTail(messages: readonly Prompt.Message[]): CacheCheckpoint | undefined {
  for (let message = messages.length - 1; message >= 0; message--) {
    const source = messages[message]!
    if (source.role === "system") continue
    for (let part = source.content.length - 1; part >= 0; part--) {
      const block = source.content[part]!
      if (block.type === "text" && block.text.length > 0 || block.type === "file" || block.type === "tool-result") return { message, part }
    }
  }
  return undefined
}
