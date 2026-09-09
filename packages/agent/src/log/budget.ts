import type { Event } from "@clavia/tardigrade-core/log/event"
import { upcast } from "./upcast"

// startingBudget resolves the allowance not represented by recorded grants (component/budget.test.ts).
export const startingBudget = (events: ReadonlyArray<Event>, fallback: number): number =>
  upcast(events).budget.startingAllowance ?? fallback

// needsInitialBudget reports whether a turn needs its starting grant (runtime/batches.test.ts).
export const needsInitialBudget = (events: ReadonlyArray<Event>): boolean =>
  upcast(events).budget.needsInitialGrant
