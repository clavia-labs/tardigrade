import { Schema } from "effect"
import { erase, machine, type Event } from "@flamecast/core"
import { EXITS, REQUEST_BUDGET } from "../exits"
import type { NativeToolSpec } from "../infer"
import { jsonSchemaOf } from "../schema"
import { budgetExhausted, budgetRequested, toolReturned } from "../alphabet"
import { defineModule } from "../module"
import { WITHDRAW_ALL, type Nudge } from "../definition"
import { turnHead, turnOf, turnView } from "../turns"

// The budget module: a silent observer of the turn's tool spend, plus the escalation lifecycle.
//
// The wall machine rests while the spend is under the turn's budget, then fires `BudgetExhausted`
// once when the spend passes it. The count lives in a guard, a pure reducer over the log, so the
// machine stays resting until the threshold and never ticks. Enforcement is elsewhere: the nudge
// withdraws the native tools that spend, and the native-tools machine refuses a dispatch after the wall. This
// machine only detects.

// A turn with no declared budget takes this, so an unbounded agent is never an accident.
export const DEFAULT_BUDGET = 40

const natural = (value: unknown): number => {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

const nonnegative = (value: unknown): number => {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0
}

const grantedOf = (view: ReadonlyArray<Event>): number => {
  let pending: string | undefined
  let granted = 0
  for (const event of view) {
    if (event.type === "BudgetRequested") {
      pending = String(event.callId ?? "")
      continue
    }
    if (
      pending === undefined ||
      String(event.callId ?? "") !== pending ||
      (event.type !== "BudgetGranted" && event.type !== "BudgetDenied")
    ) {
      continue
    }
    if (event.type === "BudgetGranted") {
      const amount = natural(event.amount)
      if (amount === 0) continue
      granted += amount
    }
    pending = undefined
  }
  return granted
}

// The turn head stores its budget. Each grant increases it. A turn keeps its initial budget after
// the harness starts another turn.
export const budgetOf = (
  log: ReadonlyArray<Event>,
  fallback: number = DEFAULT_BUDGET
): number => {
  const view = turnView(log)
  const head = turnHead(view)
  const declared = head?.budget
  const base = typeof declared === "number" && Number.isFinite(declared) && declared >= 0
    ? Math.floor(declared)
    : nonnegative(fallback)
  return base + grantedOf(view)
}

// The work-tool calls in any log span. The exits are not work, so they never draw the budget down.
export const toolCallsOf = (log: ReadonlyArray<Event>): number =>
  log.filter(
    (event) => event.type === "ToolCalled" && !EXITS.has(String(event.name ?? ""))
  ).length

// The tool calls the current turn has spent.
export const usedOf = (log: ReadonlyArray<Event>): number => toolCallsOf(turnView(log))

// Whether the turn head permits escalation at its budget wall.
export const escalatableOf = (log: ReadonlyArray<Event>): boolean =>
  turnHead(turnView(log))?.escalatable === true

// The budget phase of the current turn, read from the most recent marker scanning back. Scoped to
// the turn, so an earlier turn's wall does not leak into this one.
export type BudgetPhase = "spending" | "exhausted" | "denied"

export const budgetPhase = (log: ReadonlyArray<Event>): BudgetPhase => {
  const view = turnView(log)
  let phase: BudgetPhase = "spending"
  let pending: string | undefined
  for (const event of view) {
    if (event.type === "MessageReceived") phase = "spending"
    else if (event.type === "BudgetExhausted") phase = "exhausted"
    else if (event.type === "BudgetRequested") pending = String(event.callId ?? "")
    else if (
      pending !== undefined &&
      String(event.callId ?? "") === pending &&
      event.type === "BudgetDenied"
    ) {
      phase = "denied"
      pending = undefined
    } else if (
      pending !== undefined &&
      String(event.callId ?? "") === pending &&
      event.type === "BudgetGranted" &&
      natural(event.amount) > 0
    ) {
      phase = "spending"
      pending = undefined
    }
  }
  return phase
}

// Are the work tools withdrawn for this turn? True once the wall is recorded, until a grant reopens
// it. A declared zero closes the surface before the first model request.
export const budgetSpent = (log: ReadonlyArray<Event>): boolean =>
  budgetPhase(log) !== "spending" || budgetOf(log) === 0

// A work call is refused when its ordinal exceeds the available budget or a denial has closed the
// turn. This stays separate from `budgetSpent`, because the call that reaches the exact limit is
// allowed to finish before the surface closes.
export const budgetRefusesCall = (log: ReadonlyArray<Event>): boolean =>
  budgetPhase(log) === "denied" || usedOf(log) > budgetOf(log)

// May the model ask for more? Only while the wall is up, only when no denial has closed it, and
// only when the turn's head made it escalatable. A denied turn answers; it does not ask again.
export const canRequestBudget = (log: ReadonlyArray<Event>): boolean =>
  escalatableOf(log) &&
  (budgetPhase(log) === "exhausted" ||
    (budgetPhase(log) === "spending" && budgetOf(log) === 0))

const decisionAnswersLatestRequest = (log: ReadonlyArray<Event>): boolean => {
  const decision = log[log.length - 1]
  if (
    decision === undefined ||
    (decision.type !== "BudgetGranted" && decision.type !== "BudgetDenied")
  ) {
    return false
  }
  if (decision.type === "BudgetGranted" && natural(decision.amount) === 0) return false
  let pending: string | undefined
  for (let index = 0; index < log.length - 1; index++) {
    const event = log[index]
    if (event?.type === "BudgetRequested") pending = String(event.callId ?? "")
    else if (
      pending !== undefined &&
      String(event?.callId ?? "") === pending &&
      (event?.type === "BudgetDenied" ||
        (event?.type === "BudgetGranted" && natural(event.amount) > 0))
    ) {
      pending = undefined
    }
  }
  return pending !== undefined && pending === String(decision.callId ?? "")
}

// The wall lands when the last allowed call is recorded. The handler may finish, and the next
// model request sees a closed work-tool surface.
const budgetMachine = (defaultBudget: number) => machine({
  id: "budget",
  view: turnView,
  initial: "spending",
  states: {
    // Resting and silent while under budget. The guard flips it only when the spend passes.
    spending: {
      on: {
        ToolCalled: {
          target: "exhausted",
          when: (log) => usedOf(log) >= budgetOf(log, defaultBudget)
        }
      }
    },
    // The one active state: record the wall, then rest.
    exhausted: {
      decide: (log, now) => [
        budgetExhausted({
          turn: turnOf(log),
          budget: budgetOf(log, defaultBudget),
          used: usedOf(log),
          at: now
        })
      ],
      on: { BudgetExhausted: "spent" }
    },
    // The wall holds. A grant raises the ceiling, so `spending` rests again until the spend passes
    // the new one. A denial leaves the wall up and the turn answers.
    spent: {
      on: {
        BudgetGranted: {
          target: "spending",
          when: decisionAnswersLatestRequest
        }
      }
    }
  }
})

interface Ask {
  readonly callId: string
  readonly reason: string
  readonly amount: number
  readonly turn: string
  readonly grant?: number
  readonly denial?: string
}

const askOf = (context: Partial<Ask>): Ask => {
  if (context.callId === undefined) throw new Error("the escalation is active with no ask in context")
  return context as Ask
}

const isEscalation = (log: ReadonlyArray<Event>): boolean =>
  String(log[log.length - 1]?.name ?? "") === REQUEST_BUDGET

// The escalation machine: record the ask, park, and answer the call when the parent decides. No
// `ToolReturned` follows the ask, so the model loop rests and the turn is durably paused. A parent
// reads the park through `boundaryOf` and delivers a grant or a denial, which wakes the turn.
const escalationMachine = machine({
  id: "escalation",
  view: turnView,
  initial: "idle",
  context: {} as Partial<Ask>,
  states: {
    idle: {
      on: {
        ToolCalled: {
          target: "requesting",
          when: isEscalation,
          assign: (_, event) => {
            const args = event.arguments as { reason?: unknown; amount?: unknown } | undefined
            return {
              callId: String(event.callId ?? ""),
              reason: String(args?.reason ?? ""),
              amount: natural(args?.amount),
              turn: String(event.turn ?? "")
            }
          }
        }
      }
    },
    requesting: {
      decide: (_log, now, context) => {
        const ask = askOf(context)
        return [
          budgetRequested({
            turn: ask.turn,
            callId: ask.callId,
            reason: ask.reason,
            amount: ask.amount,
            at: now
          })
        ]
      },
      on: { BudgetRequested: "parked" }
    },
    parked: {
      on: {
        BudgetGranted: {
          target: "granting",
          when: decisionAnswersLatestRequest,
          assign: (context, event) => ({ ...context, grant: natural(event.amount) })
        },
        BudgetDenied: {
          target: "denying",
          when: decisionAnswersLatestRequest,
          assign: (context, event) => ({ ...context, denial: String(event.reason ?? "") })
        }
      }
    },
    granting: {
      decide: (_log, now, context) => {
        const ask = askOf(context)
        return [
          toolReturned({
            turn: ask.turn,
            callId: ask.callId,
            name: REQUEST_BUDGET,
            result: { granted: ask.grant ?? 0 },
            at: now
          })
        ]
      },
      on: { ToolReturned: "idle" }
    },
    denying: {
      decide: (_log, now, context) => {
        const ask = askOf(context)
        return [
          toolReturned({
            turn: ask.turn,
            callId: ask.callId,
            name: REQUEST_BUDGET,
            result: {
              denied: true,
              ...(ask.denial === undefined || ask.denial === "" ? {} : { reason: ask.denial }),
              note: "No more budget. Answer now with your best result."
            },
            at: now
          })
        ]
      },
      on: { ToolReturned: "idle" }
    }
  }
})

const WALL_TEXT =
  "Your tool budget for this turn is spent, so the work tools are gone. Answer now with your " +
  "best result from what you have already gathered."

const ESCALATE_TEXT =
  "If the work genuinely needs more and the extra spend is worth it, call request-budget with a " +
  "reason and an amount instead of answering. Ask only when it changes the result."

const REQUEST_BUDGET_INPUT = Schema.Struct({
  reason: Schema.String.annotate({
    description: "What is still missing and what the calls are for."
  }),
  amount: Schema.Finite.annotate({ description: "How many more tool calls you need." })
})

const requestBudgetTool = (description: string): NativeToolSpec => ({
  name: REQUEST_BUDGET,
  description,
  inputSchema: jsonSchemaOf(REQUEST_BUDGET_INPUT)
})

// The wall closes every base tool. It can not name them, because the tools belong to whoever
// registered them, so it withdraws the whole base surface and leaves the turn its exits.
const REQUEST_DESCRIPTION =
  "Ask for more tool-call budget when the work is not done and the budget is spent. State why " +
  "the extra spend is worth it and how many more calls you need. The parent decides: a grant " +
  "lets you keep working, a denial means finish with what you have."

export interface BudgetOptions {
  readonly defaultBudget?: number
  readonly wallText?: string
  readonly escalateText?: string
  readonly requestDescription?: string
}

export const budget = (options: BudgetOptions = {}) => {
  const defaultBudget = options.defaultBudget ?? DEFAULT_BUDGET
  if (!Number.isFinite(defaultBudget) || !Number.isInteger(defaultBudget) || defaultBudget < 0) {
    throw new Error("defaultBudget must be a nonnegative integer")
  }
  const wallText = options.wallText ?? WALL_TEXT
  const escalateText = options.escalateText ?? ESCALATE_TEXT
  const requestTool = requestBudgetTool(options.requestDescription ?? REQUEST_DESCRIPTION)
  const wallNudge: Nudge = {
    id: "budget.wall",
    when: budgetSpent,
    text: wallText,
    withdrawsNativeTools: [WITHDRAW_ALL]
  }
  const escalateNudge: Nudge = {
    id: "budget.escalate",
    when: canRequestBudget,
    text: escalateText,
    nativeTools: [requestTool]
  }
  return defineModule({
    id: "budget",
    version: "2",
    identity: { defaultBudget, wallText, escalateText, requestTool },
    setup: () => ({
      events: [
        "BudgetExhausted",
        "BudgetRequested",
        "BudgetGranted",
        "BudgetDenied",
        "ToolCalled",
        "ToolReturned"
      ],
      machines: [budgetMachine(defaultBudget), erase(escalationMachine)],
      nudges: [wallNudge, escalateNudge]
    })
  })
}
