import { ModelLock, type ModelLockData } from "./lock"
import { Effect, Layer, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { BindingSettings, CurrentModel, ModelSelection } from "@clavia/tardigrade-model/settings"
import type { ModelRef } from "./reference"
import type { ModelConfig, ModelCredentials } from "./config"

export interface ModelHostConfig {
  readonly model: ModelConfig
  readonly modelCredentials: ModelCredentials
}

export interface SelectedModel {
  readonly model_id: string
  readonly provider: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly protocol: ModelConfig["providers"][string]["protocol"]
  readonly region?: string
  readonly contextWindowTokens: number
  readonly maxOutputTokens?: number
  readonly pricing?: import("@clavia/tardigrade-model/pricing").ModelPricing
  readonly options?: ModelLockData["models"][number]["options"]
}

// modelLayerWith binds provider execution to a host-supplied ModelLock (selection.test.ts).
export const modelLayerWith = (
  credentials: ModelCredentials,
  bindingFor: (selected: SelectedModel) => Layer.Layer<LanguageModel.LanguageModel>,
  protocols?: ReadonlyArray<SelectedModel["protocol"]>
): Layer.Layer<LanguageModel.LanguageModel | ModelLock, never, ModelLock> => Layer.unwrap(Effect.map(ModelLock, lock => {
  const select = (reference?: ModelRef) => {
    const { model: referenceValue } = lock.resolve(reference)
    const definition = lock.definitions.models.find(model => model.provider === referenceValue.provider && model.model_id === referenceValue.model_id)
    if (definition === undefined) throw new Error(`model ${referenceValue.provider}/${referenceValue.model_id} is absent from models.lock.json`)
    const connection = lock.definitions.providers[definition.provider]
    if (connection === undefined) throw new Error(`provider ${definition.provider} is absent from models.lock.json`)
    const apiKey = connection.env.flatMap(name => credentials[name] === undefined ? [] : [credentials[name]!])[0]
    if (apiKey === undefined) throw new Error(`provider ${JSON.stringify(definition.provider)} needs a credential; set ${connection.env.join(" or ")} as a secret environment variable`)
    const selected: SelectedModel = { ...definition, ...connection, apiKey }
    if (protocols !== undefined && !protocols.includes(selected.protocol)) throw new Error(`inference binding does not support ${selected.protocol} for ${selected.provider}/${selected.model_id}`)
    return selected
  }
  const selection = Layer.succeed(ModelSelection, {
    settings: (reference) => Effect.suspend(() => {
      const selected = select(reference)
      return BindingSettings.pipe(Effect.provide(bindingFor(selected)))
    }),
  })
  const withModel = <A, E, R>(use: (native: LanguageModel.LanguageModel) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(CurrentModel, (reference) => Effect.flatMap(LanguageModel.LanguageModel, use).pipe(Effect.provide(bindingFor(select(reference)))))
  const model = Layer.succeed(LanguageModel.LanguageModel, {
    [LanguageModel.TypeId]: LanguageModel.TypeId,
    // generateText forwards caller toolkit services through Effect's overloaded signature.
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off
    generateText: ((...args: Parameters<typeof LanguageModel.LanguageModel.Service.generateText>) => withModel((native) => native.generateText(...args))) as typeof LanguageModel.LanguageModel.Service.generateText,
    // generateObject forwards caller schema services through Effect's generic signature.
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off
    generateObject: ((...args: Parameters<typeof LanguageModel.LanguageModel.Service.generateObject>) => withModel((native) => native.generateObject(...args))) as typeof LanguageModel.LanguageModel.Service.generateObject,
    streamText: ((...args: Parameters<typeof LanguageModel.LanguageModel.Service.streamText>) => Stream.unwrap(Effect.map(CurrentModel, (reference) => Stream.unwrap(Effect.map(LanguageModel.LanguageModel, (native) => native.streamText(...args))).pipe(Stream.provide(bindingFor(select(reference))))))) as typeof LanguageModel.LanguageModel.Service.streamText
  })
  return Layer.mergeAll(selection, model, Layer.succeed(ModelLock, lock))
}))
