import type { Event } from "@clavia/tardigrade-core/log/event"
import { DEFAULT_MODEL_POLICY_OVERRIDE, type ModelPolicyOverride } from "../../model/access"
import type { InferRequest } from "../../model/contract"

// InferPolicy states the process-crash ceiling and model authority applied by the inference machine. Output correction bounds belong to the mounted output component (component/repair.ts, RepairPolicy).
export interface InferPolicy {
  readonly giveUpAfter: number
  readonly models: ModelPolicyOverride
}

// DEFAULT_INFER_POLICY is the inference machine policy used when a caller supplies no override.
export const DEFAULT_INFER_POLICY: InferPolicy = { giveUpAfter: 3, models: DEFAULT_MODEL_POLICY_OVERRIDE }

// Render derives the model-facing surface from event history.
export type Render<R = never> = (log: ReadonlyArray<Event>) => Pick<InferRequest, "system" | "tools" | "context" | "output" | "conversation"> & {
  readonly compactionTransitions?: ReadonlyArray<import("@clavia/tardigrade-core/transition").Transition<never, R>>
}
