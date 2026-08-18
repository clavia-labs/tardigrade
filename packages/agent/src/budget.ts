import { Clock, Effect } from "effect"
import { transition, type Reactor } from "@tardigrade/core/actor"
import { budgetExhausted } from "./events"
import type { Event } from "@tardigrade/core/event"
import { turnHead, turnView } from "@tardigrade/code/turns"

// The budget reactor observes the turn's tool spend and fires BudgetExhausted once when it
// passes the brief's budget. Detection lives here; enforcement lives with the tools reactor,
// which reads the wall and refuses the next execute. See docs/agent-budgets.md.

// BudgetPolicy is the ceiling a brief with no stated budget takes, so an unbounded agent is
// never an accident. A brief that states its own `budget` overrides it per turn; this is what a
// silent brief gets, and a consumer sets it on the reactor (`budgetReactorFor`) and on the spawn
// package, which draws the same default for a child (spawn.ts).
export interface BudgetPolicy {
  readonly defaultToolBudget: number
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = { defaultToolBudget: 40 }

export const budgetPolicyOf = (policy: Partial<BudgetPolicy> = {}): BudgetPolicy => ({
  defaultToolBudget: policy.defaultToolBudget ?? DEFAULT_BUDGET_POLICY.defaultToolBudget
})

// budgetOf returns the turn's budget: the head's `budget` plus every grant the escalation has
// added, or the policy's default. The budget rides the brief envelope and is read off the raw
// event. A `BudgetGranted` raises the ceiling, which is what lets a granted turn resume.
export const budgetOf = (view: ReadonlyArray<Event>, policy: Partial<BudgetPolicy> = {}): number => {
  const head = turnHead(view) as { budget?: unknown } | undefined
  const base =
    typeof head?.budget === "number" && head.budget > 0
      ? Math.floor(head.budget)
      : budgetPolicyOf(policy).defaultToolBudget
  const granted = view.reduce((n, e) => (e.type === "BudgetGranted" ? n + Number((e as { amount?: unknown }).amount ?? 0) : n), 0)
  return base + granted
}

// usedOf counts the tool calls the turn has spent. Only `execute` spends: `answer` and
// `request_budget` are the turn's exits, so they never draw the budget down.
export const usedOf = (view: ReadonlyArray<Event>): number =>
  view.filter((e) => e.type === "ToolCalled" && String((e as { name?: unknown }).name) === "execute").length

// escalatableOf reports whether the brief lets this turn escalate at its wall. It rides the
// envelope like `budget`.
export const escalatableOf = (view: ReadonlyArray<Event>): boolean =>
  (turnHead(view) as { escalatable?: unknown } | undefined)?.escalatable === true

// shadowOf reports whether this turn's brief carries the shadow flag. It rides the envelope like
// `escalatable`: the run's fire sets it once, and every spawn downstream inherits the same
// reading.
export const shadowOf = (view: ReadonlyArray<Event>): boolean =>
  (turnHead(view) as { shadow?: unknown } | undefined)?.shadow === true

// worldOf returns the explicit world label this turn's brief carries, present when its fire
// named a shared world (docs/worlds.md). It rides the envelope like `shadow` and propagates to
// every spawn the same way, so a whole family stays on one shared world's facets. It is absent
// for the anonymous case, where a shadow run's own family.run is its world and needs no
// propagation.
export const worldOf = (view: ReadonlyArray<Event>): string | undefined => {
  const w = (turnHead(view) as { world?: unknown } | undefined)?.world
  return typeof w === "string" && w !== "" ? w : undefined
}

// BudgetPhase is the budget state of the current turn, read from the most recent lifecycle
// marker scanning back. It is pure and scoped to the current turn like `outputSchemaOf`, so an
// earlier turn's wall does not leak. `exhausted`: the wall is up and the turn may still ask.
// `denied`: the ask was refused, so the turn must answer. `spending`: a grant reopened the
// budget, or none was ever spent.
export type BudgetPhase = "spending" | "exhausted" | "denied"

export const budgetPhase = (trajectory: ReadonlyArray<Event>): BudgetPhase => {
  for (let i = trajectory.length - 1; i >= 0; i--) {
    const t = trajectory[i]!.type
    if (t === "BudgetExhausted") return "exhausted"
    if (t === "BudgetDenied") return "denied"
    if (t === "BudgetGranted") return "spending"
    if (t === "MessageReceived") return "spending"
  }
  return "spending"
}

// budgetSpent reports whether `execute` is withdrawn for this turn: true from the wall until a
// grant reopens it. The tools gate and the model's tool list both read this one predicate, so
// they never disagree.
export const budgetSpent = (trajectory: ReadonlyArray<Event>): boolean => budgetPhase(trajectory) !== "spending"

// canRequestBudget reports whether the model may ask for more: only while the wall is up, no
// denial has closed it, and the brief made the turn escalatable. A denied turn answers and never
// asks again.
export const canRequestBudget = (trajectory: ReadonlyArray<Event>): boolean =>
  budgetPhase(trajectory) === "exhausted" && escalatableOf(trajectory)

// overBudget reports whether the spend has passed the budget. It is pure and total over the log,
// so replay re-folds to the same state: it reads only the log and calls no clock and no random
// source. It is off by exactly one on purpose: `used > budget` fires on the call after the last
// allowed one, so the agent gets `budget` dispatched calls and the next is refused.
const overBudget = (log: ReadonlyArray<Event>, policy: BudgetPolicy): boolean => usedOf(log) > budgetOf(log, policy)

// budgetReactorFor derives the wall when the spend has crossed the ceiling and no wall marker
// stands. The act records `BudgetExhausted` once; the tools reactor reads it and refuses the
// next `execute`, so enforcement stays where dispatch lives and this reactor only detects. The
// wall's key is the ceiling it fired at: a grant raises the ceiling, so a second crossing is a
// new occurrence with a new key, and a redelivered wall absorbs.
export const budgetReactorFor = (policy: Partial<BudgetPolicy> = {}): Reactor<never> => (log) => {
  const resolved = budgetPolicyOf(policy)
  const view = turnView(log)
  if (view.length === 0 || !overBudget(view, resolved) || budgetPhase(view) !== "spending") return []
  const head = turnHead(view) as { id?: unknown } | undefined
  const budget = budgetOf(view, resolved)
  return [
    transition({
      key: `bw:${String(head?.id ?? "")}/${budget}`,
      input: { turn: head?.id === undefined ? undefined : String(head.id), budget, used: usedOf(view) },
      act: (input) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          return [
            budgetExhausted({
              budget: input.budget,
              used: input.used,
              ...(input.turn === undefined ? {} : { turn: input.turn }),
              at
            })
          ]
        })
    })
  ]
}

// budgetReactor is that reactor on the default ceiling.
export const budgetReactor: Reactor<never> = budgetReactorFor()
