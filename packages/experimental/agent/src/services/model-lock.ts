import { ModelInfo } from "../context"
import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { Effect, Layer } from "effect"
import { ModelLock } from "@clavia/tardigrade-model/lock"

export { ModelLock }

// resolveModel acquires locked metadata when constructing an atom graph.
export const resolveModel = Effect.flatMap(ModelLock, lock => Effect.try({
  try: () => {
    const resolution = lock.resolve()
    const contextWindowTokens = resolution.contextWindowTokens
    if (contextWindowTokens === undefined || !Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 1) {
      throw new RuntimeError("ModelLock must provide a positive integer contextWindowTokens")
    }
    return { model: resolution.model, contextWindowTokens }
  },
  catch: RuntimeError.from,
}))

export const modelInfo = Layer.effect(ModelInfo, resolveModel)
