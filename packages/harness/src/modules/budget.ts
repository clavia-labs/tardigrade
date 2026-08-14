import { erase, machine, type Event } from "@flamecast/core"
import { EXITS, REQUEST_BUDGET } from "../exits"
import type { NativeToolSpec } from "../infer"
import { defineModule } from "../module"
import { WITHDRAW_ALL, type Nudge } from "../program"
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

// The turn head stores its budget. Each grant increases it. A turn keeps its initial budget after
// the harness starts another turn.
export const budgetOf = (
  log: ReadonlyArray<Event>,
  fallback: number = DEFAULT_BUDGET
): number => {
  const view = turnView(log)
  const head = turnHead(view)
  const declared = head?.budget
  const base = typeof declared === "number" && declared > 0 ? Math.floor(declared) : fallback
  return view.reduce(
    (total, event) => (event.type === "BudgetGranted" ? total + Number(event.amount ?? 0) : total),
    base
  )
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
  for (let index = view.length - 1; index >= 0; index--) {
    const type = view[index]?.type
    if (type === "BudgetExhausted") return "exhausted"
    if (type === "BudgetDenied") return "denied"
    if (type === "BudgetGranted") return "spending"
    if (type === "MessageReceived") return "spending"
  }
  return "spending"
}

// Are the work tools withdrawn for this turn? True once the wall is recorded, until a grant reopens
// it. This is the one predicate the native tool surface and the dispatch gate both read, so they can not
// disagree about what the log forbids.
export const budgetSpent = (log: ReadonlyArray<Event>): boolean => budgetPhase(log) !== "spending"

// May the model ask for more? Only while the wall is up, only when no denial has closed it, and
// only when the turn's head made it escalatable. A denied turn answers; it does not ask again.
export const canRequestBudget = (log: ReadonlyArray<Event>): boolean =>
  budgetPhase(log) === "exhausted" && escalatableOf(log)

// The guard. Off by exactly one on purpose: `used > budget` fires on the call after the last
// allowed one, so the turn gets its budget dispatched and the wall lands behind the last return.
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
          when: (log) => usedOf(log) > budgetOf(log, defaultBudget)
        }
      }
    },
    // The one active state: record the wall, then rest.
    exhausted: {
      decide: (log, now) => [
        {
          type: "BudgetExhausted",
          turn: turnOf(log),
          budget: budgetOf(log, defaultBudget),
          used: usedOf(log),
          at: now
        }
      ],
      on: { BudgetExhausted: "spent" }
    },
    // The wall holds. A grant raises the ceiling, so `spending` rests again until the spend passes
    // the new one. A denial leaves the wall up and the turn answers.
    spent: { on: { BudgetGranted: "spending" } }
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
const escalationMachine = machine<never, Partial<Ask>>({
  id: "escalation",
  view: turnView,
  initial: "idle",
  context: {},
  states: {
    idle: {
      on: {
        ToolCalled: {
          target: "requesting",
          when: isEscalation,
          assign: (_, event) => {
            const args = event.arguments as { reason?: unknown; amount?: unknown } | undefined
            const asked = Number(args?.amount ?? 0)
            return {
              callId: String(event.callId ?? ""),
              reason: String(args?.reason ?? ""),
              amount: asked > 0 ? Math.floor(asked) : 0,
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
          {
            type: "BudgetRequested",
            turn: ask.turn,
            callId: ask.callId,
            reason: ask.reason,
            amount: ask.amount,
            at: now
          }
        ]
      },
      on: { BudgetRequested: "parked" }
    },
    parked: {
      on: {
        BudgetGranted: {
          target: "granting",
          assign: (context, event) => ({ ...context, grant: Number(event.amount ?? 0) })
        },
        BudgetDenied: {
          target: "denying",
          assign: (context, event) => ({ ...context, denial: String(event.reason ?? "") })
        }
      }
    },
    granting: {
      decide: (_log, now, context) => {
        const ask = askOf(context)
        return [
          {
            type: "ToolReturned",
            turn: ask.turn,
            callId: ask.callId,
            name: REQUEST_BUDGET,
            result: { granted: ask.grant ?? 0 },
            at: now
          }
        ]
      },
      on: { ToolReturned: "idle" }
    },
    denying: {
      decide: (_log, now, context) => {
        const ask = askOf(context)
        return [
          {
            type: "ToolReturned",
            turn: ask.turn,
            callId: ask.callId,
            name: REQUEST_BUDGET,
            result: {
              denied: true,
              ...(ask.denial === undefined || ask.denial === "" ? {} : { reason: ask.denial }),
              note: "No more budget. Answer now with your best result."
            },
            at: now
          }
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

const requestBudgetTool = (description: string): NativeToolSpec => ({
  name: REQUEST_BUDGET,
  description,
  inputSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "What is still missing and what the calls are for." },
      amount: { type: "number", description: "How many more tool calls you need." }
    },
    required: ["reason", "amount"],
    additionalProperties: false
  }
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
      events: ["BudgetExhausted", "BudgetRequested", "BudgetGranted", "BudgetDenied"],
      machines: [budgetMachine(defaultBudget), erase(escalationMachine)],
      nudges: [wallNudge, escalateNudge]
    })
  })
}
