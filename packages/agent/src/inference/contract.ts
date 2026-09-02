import { Context, Effect } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { Action } from "../log/events"
import type { ContextPolicy } from "../component/compaction"
import type { OutputFallback } from "../output/contract"
import type { ModelRef } from "./reference"
import { DEFAULT_MODEL_POLICY_OVERRIDE, type ModelPolicy, type ModelPolicyOverride } from "./access"
import type { InferenceIdentity } from "./observer"

// InferPolicy states the process-crash ceiling and model authority applied by the inference machine. Output correction bounds belong to the mounted output component (component/repair.ts, RepairPolicy).
export interface InferPolicy {
  readonly giveUpAfter: number
  readonly models: ModelPolicyOverride
}

// DEFAULT_INFER_POLICY is the inference machine policy used when a caller supplies no override.
export const DEFAULT_INFER_POLICY: InferPolicy = { giveUpAfter: 3, models: DEFAULT_MODEL_POLICY_OVERRIDE }

// InferRequest is one attempt's trajectory and model-facing surface. The actor derives the surface so a binding holds no tool, context, or output policy.
export interface InferRequest {
  readonly trajectory: ReadonlyArray<Event>
  readonly identity: InferenceIdentity
  readonly model?: ModelRef
  readonly system: string
  readonly tools: ReadonlyArray<import("./request").ToolSpec>
  readonly context?: Partial<ContextPolicy>
  readonly output?: { readonly fallback: OutputFallback; readonly system?: string }
}

export interface ModelResolution {
  readonly model: ModelRef
  // models is the interpreter's current authority for validating this call. It is not recorded.
  readonly models?: ModelPolicy
}

// Infer provides one model action for one inference request. key is the ModelCalled attempt identity and may be forwarded as a provider idempotency key. Action call ids must be fresh across turns because recorded tool pairs deduplicate by call id.
export class Infer extends Context.Service<
  Infer,
  {
    readonly react: (request: InferRequest, key?: string, signal?: AbortSignal) => Effect.Effect<Action>
    readonly resolve?: (reference?: ModelRef) => ModelResolution
  }
>()("agent/Infer") {}

// NativeOutputSupport proves that an Infer binding supports native structured output beside tools (component/native-output.ts).
export class NativeOutputSupport extends Context.Service<
  NativeOutputSupport,
  { readonly withTools: true }
>()("agent/NativeOutputSupport") {}

// Render derives the model-facing surface from event history.
export type Render = (log: ReadonlyArray<Event>) => {
  readonly system: string
  readonly tools: ReadonlyArray<import("./request").ToolSpec>
  readonly context?: Partial<ContextPolicy>
  readonly output?: { readonly fallback: OutputFallback; readonly system?: string }
}
