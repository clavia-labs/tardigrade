import type { InvocationRef } from "@clavia/tardigrade-core/interaction/invocation"
import type { Intent } from "@clavia/tardigrade-core/intent"
import type { ComponentResult } from "@clavia/tardigrade-core/component"
import { bindTransitionContext, transitionKeyOf } from "@clavia/tardigrade-core/transition/transition"
import {
  component as defineComponent,
  type Component,
  type ChildOf,
  type ComponentWork,
  type ComponentReadonly,
  type ComponentRequirements,
  type ComponentView,
  type ComponentViews
} from "@clavia/tardigrade-core/actor"
import { budgetDenied, budgetExhausted, budgetGranted } from "../../log/events"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { turnEpochOf, turnHead } from "@clavia/tardigrade-code/execution/turns"
import {
  initialTurnProjection,
  reduceTurnProjection,
  turnViewFrom,
  type TurnProjectionState
} from "@clavia/tardigrade-code/execution/turn-projection"
import { Chunk, HashSet } from "effect"
import { AGENT_VIEW_ALGEBRA, type AgentComponent, type AgentView } from "../view"
import { eventAt, eventPositionOf } from "@clavia/tardigrade-core/event"

// BudgetPolicy sets the allowance for turns that declare no budget (budget.test.ts).
export interface BudgetPolicy {
  readonly limit: number
}

export interface BudgetOptions<ChildView, Result = unknown> extends Partial<BudgetPolicy> {
  readonly onExhausted: (
    reason: string,
    settle: (result: NoInfer<Result>) => Intent<never> | undefined
  ) => Intent<never> | undefined
  readonly rejectionMessage?: string
  // usage measures current cumulative turn usage (integration/budget-infer.test.ts).
  readonly usage: (childView: ComponentReadonly<ChildView>) => number
  readonly view?: (childView: ComponentReadonly<ChildView>, budget: BudgetState) => ChildView
}

// DEFAULT_BUDGET_POLICY is the default policy applied by budget and spawned agents.
export const DEFAULT_BUDGET_POLICY: BudgetPolicy = { limit: 40 }

// budgetPolicyOf applies the exported default to omitted policy fields.
export const budgetPolicyOf = (policy: Partial<BudgetPolicy> = {}): BudgetPolicy => {
  const limit = policy.limit ?? DEFAULT_BUDGET_POLICY.limit
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`budget limit must be a positive finite number, got ${JSON.stringify(limit)}`)
  }
  return { limit }
}

// initialAllowance reads the turn option before the initial grant is committed (budget.test.ts).
const initialAllowance = (events: ReadonlyArray<Event>, fallback: number): number => {
  const amount = turnHead(events)?.budget
  return typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? amount : fallback
}

// budgetOf uses the configured allowance until its initial grant is committed (budget.test.ts).
export const budgetOf = (view: ReadonlyArray<Event>, policy: Partial<BudgetPolicy> = {}): number => {
  const base = view.some((event) => event.type === "BudgetGranted" && event.initial === true)
    ? 0 : initialAllowance(view, budgetPolicyOf(policy).limit)
  const granted = view.reduce(
    (n, e) => (e.type === "BudgetGranted" ? n + Number((e as { amount?: unknown }).amount ?? 0) : n),
    0
  )
  return base + granted
}

// BudgetPhase names whether a turn may spend, request more budget, or must finish.
export type BudgetPhase = "spending" | "exhausted" | "denied"

// BudgetState exposes the applied allowance and observed usage for the current turn (budget.test.ts).
export interface BudgetState {
  readonly limit: number
  readonly used: number
  readonly remaining: number
  readonly phase: BudgetPhase
}

// budgetPhase returns the phase established by the latest lifecycle marker
// (budget.test.ts, "budgetPhase reads the most recent marker").
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

// budgetSpent reports whether the budgeted subtree is withdrawn for this turn.
export const budgetSpent = (trajectory: ReadonlyArray<Event>): boolean => budgetPhase(trajectory) !== "spending"

// DEFAULT_BUDGET_REJECTION describes a refusal independently of the governed child (budget.test.ts).
export const DEFAULT_BUDGET_REJECTION = "Budget exhausted."

type BudgetInput =
  Component<object, never> | Component<object, unknown> | ReadonlyArray<AgentComponent<never> | AgentComponent<unknown>>
type BudgetView<C> =
  C extends ReadonlyArray<AgentComponent<unknown>> ? AgentView & { readonly children: ComponentViews<C> } : ComponentView<C> & object
type BudgetRequirements<C> =
  C extends ReadonlyArray<AgentComponent<unknown>> ? ComponentRequirements<C[number]> : ComponentRequirements<C>

// BudgetControl describes decisions accepted by a budget (escalation.test.ts).
export interface BudgetControl {
  readonly grant: (amount: number, request: { readonly callId: string; readonly turn: string }, at: number) => Event
  readonly deny: (reason: string, request: { readonly callId: string; readonly turn: string }, at: number) => Event
}

// BudgetComponent exposes allowance state and the decision protocol for its parent (escalation.test.ts).
export type BudgetComponent<R = never, Result = never, View = AgentView> = Component<View & BudgetState, R, Result> & { readonly budget: BudgetControl }

// budget rejects response-capable work when current usage exceeds the allowance (budget.test.ts).
export const budget = <
  const C extends BudgetInput
>(
  components: C,
  options: BudgetOptions<BudgetView<C>, NoInfer<ComponentResult<C extends ReadonlyArray<unknown> ? C[number] : C>>>
): BudgetComponent<BudgetRequirements<C>, ComponentResult<C extends ReadonlyArray<unknown> ? C[number] : C>, BudgetView<C>> => {
  type Result = ComponentResult<C extends ReadonlyArray<unknown> ? C[number] : C>
  type R = BudgetRequirements<C>
  type ChildView = BudgetView<C>
  const resolved = budgetPolicyOf(options)
  const name = "budget"
  const combined = (
    Array.isArray(components)
      ? defineComponent({
          name: `${name}.children`,
          children: components as ReadonlyArray<AgentComponent<unknown>>,
          initial: () => undefined,
          step: state => state,

        output: (_state, children) => {
          const outputs = children.map(child => child.output())
          return {
            view: { ...outputs.reduce((view, output) => AGENT_VIEW_ALGEBRA.combine(view, output.view), AGENT_VIEW_ALGEBRA.empty), children: outputs.map(output => output.view) },
            transitions: outputs.flatMap(output => output.transitions),
            interactions: {
              cancel: (cancellation) => children.flatMap(child => child.output().interactions?.cancel?.(cancellation) ?? [])
            }
          }
        }
        })
      : components
  ) as unknown as Component<ChildView, R, Result>
  const measure = (childView: ComponentReadonly<ChildView>): number => {
    const used = options.usage(childView)
    if (!Number.isFinite(used) || used < 0) throw new Error("budget usage must be a finite nonnegative number")
    return used
  }
  type Child = ChildOf<typeof combined>
  const refuse = (transition: ComponentWork<R, Result>): Intent<never> | undefined =>
    transition.respond === undefined ? undefined :
      options.onExhausted(options.rejectionMessage ?? DEFAULT_BUDGET_REJECTION, transition.respond)
  const derived = (
    child: Child,
    trajectory: ReadonlyArray<Event>,
    log: ReadonlyArray<Event>,
    refused: ReadonlyArray<Intent<never>>,
    admitted: HashSet.HashSet<string>
  ) => {
    const children = child.output()
    const used = measure(children.view)
    const allowance = budgetOf(trajectory, resolved)
    const exhaustion = (event: Event, used: number, tag = "wall", invocation?: InvocationRef | null): Intent<never> =>
      bindTransitionContext(event, name).intent(tag, (at) => budgetExhausted({
        budget: allowance, used, at,
        ...(event.turn === undefined ? {} : { turn: String(event.turn) })
      }), invocation === undefined ? {} : { invocation })
    const position = eventPositionOf(log[log.length - 1] ?? { type: "Empty" }) ?? log.length
    const rejected: Array<Intent<never>> = []
    const selected = children.transitions.flatMap((transition): ReadonlyArray<ComponentWork<R, Result>> => {
      const completion = refuse(transition)
      if (completion !== undefined && refused.some((refusal) => refusal.key === completion.key)) return []
      if (used <= allowance || transition.respond === undefined || (completion !== undefined && HashSet.has(admitted, completion.key))) return [transition]
      if (completion !== undefined) rejected.push(completion)
      if (budgetPhase(trajectory) !== "spending") return []
      const head = turnHead(trajectory)
      const invocation =
        transition.invocation ??
        (head === undefined
          ? undefined
          : { method: "message", id: String(head.id), epoch: turnEpochOf(trajectory, String(head.id)) })
      return [exhaustion(
        eventAt({ type: "BudgetCheck", ...(invocation === undefined ? {} : { turn: invocation.id }) }, position),
        used, `wall/${transition.key}`, invocation ?? null
      )]
    })
    const recorded = new Set(log.map(transitionKeyOf).filter((key) => key !== undefined))
    const refusals = refused.filter((transition) => !recorded.has(transition.key))
    const wall = refusals.length > 0 && used > allowance && budgetPhase(trajectory) === "spending" && log.length > 0
      ? [exhaustion(log[log.length - 1]!, used)] : []
    const head = turnHead(trajectory)
    const initial =
      head !== undefined && !trajectory.some((event) => event.type === "BudgetGranted" && event.initial === true)
        ? [
            bindTransitionContext(head, name).intent("budget.initial", (at) =>
              budgetGranted({
                amount: initialAllowance(trajectory, resolved.limit),
                initial: true,
                turn: String(head.id),
                at
              })
            )
          ]
        : []
    const state: BudgetState = {
      limit: allowance,
      used,
      remaining: Math.max(0, allowance - used),
      phase: budgetPhase(trajectory)
    }
    return {
      rejected,
      view: { ...(options.view?.(children.view, state) ?? children.view), ...state } as ChildView & BudgetState,
      transitions: [...initial, ...wall, ...refusals, ...selected, ...rejected] as ReadonlyArray<ComponentWork<R, Result>>
    }
  }

  type BudgetMachineState = {
    readonly turns: TurnProjectionState
    readonly log: Chunk.Chunk<Event>
    readonly refused: ReadonlyArray<Intent<never>>
    // admitted preserves work accepted before later requests cross the limit (runtime/batches.test.ts).
    readonly admitted: HashSet.HashSet<string>
  }
  const component = defineComponent<BudgetMachineState, ChildView & BudgetState, R, Result, typeof combined>({
    children: combined,
    name,
    initial: (child) => {
      measure(child.output().view)
      return {
        turns: initialTurnProjection(),
        log: Chunk.empty<Event>(),
        refused: [],
        admitted: HashSet.empty<string>()
      }
    },
    step: (state, event, _context, candidate, previousChild) => {
      const refused = [...state.refused]
      if (event.type === "BudgetExhausted") {
        const prior = derived(previousChild, turnViewFrom(state.turns), Chunk.toReadonlyArray(state.log), state.refused, state.admitted)
        if (prior.transitions.some((transition) => transition.key === transitionKeyOf(event))) refused.push(...prior.rejected)
      }
      const turns = reduceTurnProjection(state.turns, event)
      let admitted = state.admitted
      const affordable = measure(candidate.output().view) <= budgetOf(turnViewFrom(turns), resolved)
      for (const transition of candidate.output().transitions) {
        const completion = refuse(transition)
        if (completion === undefined || HashSet.has(admitted, completion.key) || refused.some(refusal => refusal.key === completion.key)) continue
        if (affordable) admitted = HashSet.add(admitted, completion.key)
        else refused.push(completion)
      }
      return { turns, log: Chunk.append(state.log, event), refused, admitted }
    },

    output: (state, child) => {
      const { rejected: _rejected, ...output } = derived(child, turnViewFrom(state.turns), Chunk.toReadonlyArray(state.log), state.refused, state.admitted)
      return {
        ...output,
        interactions: {
          cancel: (cancellation) => child.output().interactions?.cancel?.(cancellation) ?? []
        }
      }
    }
  })
  return {
    ...component,
    budget: {
      grant: (amount, request, at) => {
        if (!Number.isFinite(amount) || amount <= 0) throw new Error("budget grant must be a positive finite number")
        return budgetGranted({ ...request, amount, at })
      },
      deny: (reason, request, at) => budgetDenied({ ...request, reason, at })
    }
  }
}
