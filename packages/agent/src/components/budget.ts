import { intent, type Transition, type Intent } from "@clavia/tardigrade-core/reconciliation"
import { composeComponents, type ComponentRequirements } from "@clavia/tardigrade-core/actor"
import { budgetExhausted, budgetRequested } from "../log/events"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { turnHead, turnView } from "@clavia/tardigrade-code/execution/turns"
import { AGENT_VIEW_ALGEBRA, type AgentComponent, type AgentTool } from "../runtime/composition"
import type { ToolSpec } from "../inference/request"

// BudgetPolicy sets the default tool-call ceiling for turns that declare no budget.
export interface BudgetPolicy {
  readonly defaultToolBudget: number
}

// DEFAULT_BUDGET_POLICY is the default policy applied by budget and spawned agents.
export const DEFAULT_BUDGET_POLICY: BudgetPolicy = { defaultToolBudget: 40 }

// budgetPolicyOf applies the exported default to omitted policy fields.
export const budgetPolicyOf = (policy: Partial<BudgetPolicy> = {}): BudgetPolicy => ({
  defaultToolBudget: policy.defaultToolBudget ?? DEFAULT_BUDGET_POLICY.defaultToolBudget
})

// budgetOf returns the turn's declared or default budget plus every recorded grant
// (budget.test.ts, "a grant raises the ceiling, so budgetOf grows and the machine reopens").
export const budgetOf = (view: ReadonlyArray<Event>, policy: Partial<BudgetPolicy> = {}): number => {
  const head = turnHead(view) as { budget?: unknown } | undefined
  const base =
    typeof head?.budget === "number" && head.budget > 0
      ? Math.floor(head.budget)
      : budgetPolicyOf(policy).defaultToolBudget
  const granted = view.reduce((n, e) => (e.type === "BudgetGranted" ? n + Number((e as { amount?: unknown }).amount ?? 0) : n), 0)
  return base + granted
}

// escalatableOf reports whether the turn head permits budget escalation.
export const escalatableOf = (view: ReadonlyArray<Event>): boolean =>
  (turnHead(view) as { escalatable?: unknown } | undefined)?.escalatable === true

// shadowOf reports whether the turn head marks a shadow run.
export const shadowOf = (view: ReadonlyArray<Event>): boolean =>
  (turnHead(view) as { shadow?: unknown } | undefined)?.shadow === true

// worldOf returns the shared world named by the turn head, if present (docs/worlds.md).
export const worldOf = (view: ReadonlyArray<Event>): string | undefined => {
  const w = (turnHead(view) as { world?: unknown } | undefined)?.world
  return typeof w === "string" && w !== "" ? w : undefined
}

// BudgetPhase names whether a turn may spend, request more budget, or must finish.
export type BudgetPhase = "spending" | "exhausted" | "denied"

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

// canRequestBudget reports whether an escalatable turn is at an open budget wall.
export const canRequestBudget = (trajectory: ReadonlyArray<Event>): boolean =>
  budgetPhase(trajectory) === "exhausted" && escalatableOf(trajectory)

const wallFor = (
  trajectory: ReadonlyArray<Event>,
  policy: BudgetPolicy,
  used: number
): Intent<never> | undefined => {
  if (trajectory.length === 0 || budgetPhase(trajectory) !== "spending") return undefined
  const budget = budgetOf(trajectory, policy)
  if (used <= budget) return undefined
  const head = turnHead(trajectory) as { id?: unknown } | undefined
  return intent({
    key: `bw:${String(head?.id ?? "")}/${budget}`,
    input: { turn: head?.id === undefined ? undefined : String(head.id), budget, used },
    events: (input, at) => [
      budgetExhausted({
        budget: input.budget,
        used: input.used,
        ...(input.turn === undefined ? {} : { turn: input.turn }),
        at
      })
    ]
  })
}

const REQUEST_BUDGET_TOOL: ToolSpec = {
  name: "request_budget",
  description:
    "Ask for more tool-call budget when the work is not done and the budget is spent. State why the extra spend is worth it and how many more calls you need. The parent decides; a grant lets you keep working, a denial means finish with what you have.",
  inputSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Why more budget is worth it: what is still missing and what you will do with the calls." },
      amount: { type: "number", description: "How many more tool calls you need." }
    },
    required: ["reason", "amount"],
    additionalProperties: false
  }
}

const BUDGET_NUDGE =
  "Your tool budget for this turn is spent, so the budgeted tools are gone. Finish now: answer with your best result from what you have already gathered."

const ESCALATE_NUDGE =
  "If the work genuinely needs more and the extra spend is worth it, you may call request_budget with a reason and an amount instead of answering. Ask only when it changes the result; otherwise answer now."

const field = (event: Event, name: string): string => String((event as Record<string, unknown>)[name] ?? "")

const requestBudgetTool: AgentTool = {
  spec: REQUEST_BUDGET_TOOL,
  serve: (call, log, answer) => {
    const stamp = call.turn === undefined ? {} : { turn: call.turn }
    const requested = log.some(
      (event) => event.type === "BudgetRequested" && field(event, "callId") === call.callId
    )
    if (requested) {
      const decision = log.find(
        (event) =>
          (event.type === "BudgetGranted" || event.type === "BudgetDenied") &&
          field(event, "callId") === call.callId &&
          (call.turn === undefined || field(event, "turn") === "" || field(event, "turn") === call.turn)
      )
      if (decision === undefined) return []
      if (decision.type === "BudgetGranted") {
        return [answer({ granted: Number((decision as { amount?: unknown }).amount ?? 0) })]
      }
      const reason = field(decision, "reason")
      return [answer({
        denied: true,
        ...(reason === "" ? {} : { reason }),
        note: "No more budget. Answer now with your best result."
      })]
    }
    const args = call.arguments as { reason?: unknown; amount?: unknown } | undefined
    const amount = typeof args?.amount === "number" && args.amount > 0 ? Math.floor(args.amount) : 0
    return [
      intent({
        key: `br:${call.callId}`,
        input: { callId: call.callId, reason: String(args?.reason ?? ""), amount },
        events: (input, at) => [budgetRequested({ ...input, ...stamp, at })]
      })
    ]
  }
}

const usedBy = (trajectory: ReadonlyArray<Event>, toolNames: ReadonlySet<string>): number =>
  trajectory.filter(
    (event) => event.type === "ToolCalled" && toolNames.has(String((event as { name?: unknown }).name))
  ).length

const guardedTool = <R>(
  tool: AgentTool<R>,
  toolNames: ReadonlySet<string>,
  policy: BudgetPolicy
): AgentTool<R> => ({
  spec: tool.spec,
  serve: (call, log, answer): ReadonlyArray<Transition<never, R>> => {
    const trajectory = turnView(log)
    if (budgetSpent(trajectory)) {
      return [answer({
        error: "Tool budget reached. Do not call this tool again. Answer now with your best result from what you have already gathered."
      })] as ReadonlyArray<Transition<never, R>>
    }
    const wall = wallFor(trajectory, policy, usedBy(trajectory, toolNames))
    if (wall !== undefined) return [wall]
    return tool.serve(call, log, answer)
  }
})

// budget applies tool-call admission to an agent subtree. It records the wall before dispatching the
// first call over the limit (budget.test.ts, "settling an over-budget execute records the wall and
// never dispatches the call").
export const budget = <
  const Cs extends ReadonlyArray<AgentComponent<never> | AgentComponent<unknown>>
>(
  components: Cs,
  policy: Partial<BudgetPolicy> = {}
): AgentComponent<ComponentRequirements<Cs[number]>> => {
  type R = ComponentRequirements<Cs[number]>
  const resolved = budgetPolicyOf(policy)
  const combined = composeComponents("budget.children", AGENT_VIEW_ALGEBRA, components) as AgentComponent<R>
  return {
    name: "budget",
    ...(combined.keys === undefined ? {} : { keys: combined.keys }),
    derive: (log) => {
      const children = combined.derive(log)
      const trajectory = turnView(log)
      const spent = budgetSpent(trajectory)
      const canRequest = canRequestBudget(trajectory)
      const toolNames = new Set(children.view.tools.map((tool) => tool.spec.name))
      return {
        view: {
          system: spent
            ? [...children.view.system, canRequest ? `${BUDGET_NUDGE}\n${ESCALATE_NUDGE}` : BUDGET_NUDGE]
            : children.view.system,
          tools: spent
            ? (canRequest ? [requestBudgetTool] : [])
            : children.view.tools.map((tool) => guardedTool(tool as AgentTool<R>, toolNames, resolved)),
          context: children.view.context,
          output: children.view.output
        },
        transitions: children.transitions
      }
    }
  }
}
