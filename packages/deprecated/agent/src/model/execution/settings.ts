import { Context } from "effect"
import type { InferRequest } from "../contract"
import type { InferDelta } from "../observer"
export { BindingSettings, CurrentModel, ModelSelection, ProviderRequestKey, type BindingOptions } from "@clavia/tardigrade-model/settings"

export const BindingInvocation = Context.Reference<{
  readonly request: InferRequest
  readonly key?: string | undefined
  readonly signal?: AbortSignal | undefined
  readonly onDelta?: ((delta: InferDelta) => void) | undefined
} | undefined>("tardie/BindingInvocation", { defaultValue: () => undefined })
