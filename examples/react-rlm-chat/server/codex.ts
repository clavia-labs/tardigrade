import { ConfigProvider, Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { FetchHttpClient } from "effect/unstable/http"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createProviderLayer, DEFAULT_BASE_URL, listModels, MODEL_LIST_DEFAULTS } from "tardie/model/providers/codex"
import { modelLockOf } from "tardie/model/lock"
import { bunModelServices } from "tardie/deprecated/server/model-services"
import { savedCredentials } from "../../codex-provider/credentials"

export const DEFAULT_CODEX_STATE_DIRECTORY = fileURLToPath(new URL(".tardigrade/codex", import.meta.url))
export const DEFAULT_CODEX_CREDENTIALS_FILE = fileURLToPath(new URL("../../codex-provider/.codex-credentials.json", import.meta.url))

// codexModelServices binds the research host to account models and shared token renewal (codex.test.ts).
export const codexModelServices = async (env: Readonly<Record<string, string | undefined>>) => {
  const model = env.CODEX_MODEL?.trim()
  if (!model) throw new Error("Set CODEX_MODEL to an ID from the Codex example's models command")
  const auth = await Effect.runPromise(savedCredentials(DEFAULT_CODEX_CREDENTIALS_FILE).pipe(
    Effect.provide(Layer.merge(BunServices.layer, FetchHttpClient.layer)),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env))
  ))
  const baseUrl = env.CODEX_BASE_URL ?? DEFAULT_BASE_URL
  const models = await Effect.runPromise(listModels(auth, {
    baseUrl,
    clientVersion: env.CODEX_CLIENT_VERSION ?? MODEL_LIST_DEFAULTS.clientVersion,
    requestMs: Number(env.CODEX_MODEL_LIST_MS ?? MODEL_LIST_DEFAULTS.requestMs)
  }).pipe(Effect.provide(FetchHttpClient.layer)))
  const selected = models.find(entry => entry.slug === model && entry.visibility !== "hide")
  if (!selected) throw new Error(`Codex model ${model} is unavailable. Available models: ${models.filter(entry => entry.visibility !== "hide").map(entry => entry.slug).join(", ")}`)
  const contextWindowTokens = env.CODEX_CONTEXT_WINDOW_TOKENS === undefined ? selected.context_window : Number(env.CODEX_CONTEXT_WINDOW_TOKENS)
  if (contextWindowTokens === undefined) throw new Error("Codex omits its context window; set CODEX_CONTEXT_WINDOW_TOKENS explicitly")
  const reference = { provider: "codex", model_id: model }
  const policy = { default: reference, allow: [{ provider: "codex", model_ids: [model] }] }
  const providers = { codex: { baseUrl, protocol: "openai-responses" as const, env: ["CODEX_ACCESS_TOKEN"] } }
  const definitions = modelLockOf({ schema: 2, providers, models: [{ ...reference, contextWindowTokens, toolCall: true, source: `${baseUrl}/models` }] })
  const directory = join(env.CODEX_STATE_DIRECTORY ?? DEFAULT_CODEX_STATE_DIRECTORY, encodeURIComponent(model))
  await mkdir(directory, { recursive: true })
  const configFile = join(directory, "wrangler.jsonc")
  await writeFile(configFile, JSON.stringify({ vars: { TARDIGRADE_CONFIG: { models: { ...policy, providers } } } }))
  await writeFile(join(directory, "models.lock.json"), JSON.stringify(definitions))
  const credentials = await Effect.runPromise(auth.credentials)
  return bunModelServices({
    configFile,
    env: { ...env, CODEX_ACCESS_TOKEN: credentials.accessToken },
    model: { providerLayer: createProviderLayer(auth) }
  })
}
