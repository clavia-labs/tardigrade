import type { Transition } from "@clavia/tardigrade-core/transition"

/**
 * ComponentOutput contains one component's view and enabled transitions (tla/runtime/Projection.tla, ViewFaithful; tla/runtime/Reconcile.tla, NoVoid).
 *
 *   ComponentOutput<View, Requirements>
 *                   │          │
 *                   │          └─ services its effects may require
 *                   └──────────── value observed by its parent
 *
 */
export interface ComponentOutput<View, Requirements = never> {
  readonly view: View
  readonly transitions: ReadonlyArray<Transition<never, Requirements>>
}
