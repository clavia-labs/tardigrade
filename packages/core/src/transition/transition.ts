import type { ExternalEffect } from "@clavia/tardigrade-core/effect"
import type { Intent } from "@clavia/tardigrade-core/intent"

// Transition is an intent or external effect offered from one event snapshot.
export type Transition<Input = unknown, Requirements = never> =
  | Intent<Input>
  | ExternalEffect<Input, Requirements>

export * from "./projection"
