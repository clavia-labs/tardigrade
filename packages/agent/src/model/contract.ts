import { Context } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { ContextPolicy } from "../component/compact/index"
import type { OutputFallback } from "../output/contract"
import type { ModelRef } from "./reference"
import type { InferenceIdentity } from "./observer"

// InferRequest is one attempt's trajectory and model-facing surface. The actor derives the surface so a binding holds no tool, context, or output policy.
export interface InferRequest {
  readonly trajectory: ReadonlyArray<Event>
  readonly identity: InferenceIdentity
  readonly model?: ModelRef
  readonly system: string
  readonly tools: ReadonlyArray<import("./request").ToolSpec>
  readonly context?: Partial<ContextPolicy>
  readonly conversation?: import("../component/view").MessageView
  readonly output?: { readonly fallback: OutputFallback; readonly system?: string }
}

export type { ModelResolution } from "@clavia/tardigrade-model/reference"

// NativeOutputSupport declares support for native structured output beside tools (component/native-output.ts).
export class NativeOutputSupport extends Context.Service<
  NativeOutputSupport,
  { readonly withTools: true }
>()("agent/NativeOutputSupport") {}
