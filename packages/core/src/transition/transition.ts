import type { ExternalEffect } from "@clavia/tardigrade-core/effect"
import type { Intent } from "@clavia/tardigrade-core/intent"

/**
 * Transition is an Intent or ExternalEffect offered from one event snapshot.
 *
 *   Transition<Input, Requirements>
 *              │          │
 *              │          └─ services an external effect may require
 *              └──────────── private input carried by the work
 *
 * Intent proposes events directly. ExternalEffect performs outside-world work before returning events. Their kind field lets the runtime distinguish them while preserving one ordered work collection.
 */
export type Transition<Input = unknown, Requirements = never> =
  | Intent<Input>
  | ExternalEffect<Input, Requirements>
