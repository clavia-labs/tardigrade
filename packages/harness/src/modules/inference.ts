import { Clock, Context, Effect, Option } from "effect"
import { EventLog, Router, Self, erase, machine, type Event, type Machine } from "@flamecast/core"
import {
  Infer,
  selectedInference,
  settledUsage,
  reservedUsage,
  usageOf,
  type Action,
  type InferenceSelection,
  type InferenceState
} from "../infer"
import {
  messageReceived,
  modelCalled,
  modelDeferred,
  modelReturned,
  modelSettled,
  replyDelivered,
  textReturned,
  toolCalled,
  turnCompleted,
  turnFailed
} from "../alphabet"
import { defineModule } from "../module"
import type { Projection } from "../projection"
import type { RenderPlan } from "../definition"
import { modelRequest } from "../render"
import { replyView, treeUsageIn, turnView } from "../turns"
import { vercelGatewayInference } from "../providers/vercel-gateway"

const BASE_SYSTEM =
  "You are an agent. Read the conversation, use the tools you are offered when they help, and " +
  "answer the person who wrote to you. When the work is done, reply in plain text: that reply is " +
  "your final answer and it ends the turn."

export class InferenceStateProjection extends Context.Service<
  InferenceStateProjection,
  Projection<InferenceState>
>()("flamecast/InferenceStateProjection") {}

export interface InferenceSettings {
  readonly system?: string
  readonly giveUpAfter?: number
  readonly deferAtMost?: number
  readonly repairAtMost?: number
  readonly messageTruncateAt?: number
  readonly resultTruncateAt?: number
}

// A module says which model answers, and saying that means saying what the model accepts. Either
// name a provider, which already holds its window, or name the window and take the default gateway
// with it. There is no third form, because the third form is the one where the framework picks a
// number for a model it has never met.
//
// A provider built by asking a gateway comes from `yield* vercelGatewayInference()`, which reads the
// window from the model and hands back a provider to pass here.
export type InferenceOptions =
  | (InferenceSettings & {
      readonly provider: InferenceSelection
      readonly contextWindow?: number
    })
  | (InferenceSettings & {
      readonly provider?: InferenceSelection
      readonly contextWindow: number
    })

const diedAttempts = (view: ReadonlyArray<Event>): number => {
  let died = 0
  for (let index = view.length - 1; index >= 0; index--) {
    if (view[index]?.type !== "ModelCalled") break
    died += 1
  }
  return died
}

const openCallId = (view: ReadonlyArray<Event>): string | undefined => {
  for (let index = view.length - 1; index >= 0; index--) {
    const event = view[index]
    if (event?.type === "ModelReturned") return undefined
    if (event?.type === "ModelCalled") return String(event.callId ?? "")
  }
  return undefined
}

const lastCalled = (view: ReadonlyArray<Event>): Event | undefined => {
  for (let index = view.length - 1; index >= 0; index--) {
    const event = view[index]
    if (event?.type === "ModelCalled") return event
  }
  return undefined
}

const closeOrphan = (view: ReadonlyArray<Event>, turn: string, at: number): ReadonlyArray<Event> => {
  const called = lastCalled(view)
  if (called === undefined) return []
  return [
    modelSettled({
      turn,
      callId: String(called.callId ?? ""),
      usage: usageOf(called.reserved),
      reason: "the model attempt died",
      at
    })
  ]
}

const completedCalls = (view: ReadonlyArray<Event>) =>
  view.filter((event) => event.type === "ModelReturned").length

const deferralsOf = (view: ReadonlyArray<Event>, callId: string) =>
  view.filter((event) => event.type === "ModelDeferred" && String(event.callId ?? "") === callId)
    .length

// A single wait is capped at twenty minutes, which is long enough for a queued tier to drain and
// short enough that a missing Retry-After still bounds the park. Exponential backoff without a
// header starts at five seconds, then twenty, then eighty, and hits the cap on the fifth wait.
const DEFER_CAP_MS = 20 * 60 * 1000

const deferDelayMs = (attempt: number, retryAfterMs?: number) => {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(DEFER_CAP_MS, retryAfterMs)
  }
  return Math.min(DEFER_CAP_MS, 5_000 * 4 ** Math.max(0, attempt - 1))
}

const consequenceOf = (action: Action, turn: string, at: number): Event =>
  action.kind === "call"
    ? toolCalled({
        turn,
        callId: action.callId,
        name: action.name,
        arguments: action.arguments,
        at
      })
    : action.kind === "complete"
      ? turnCompleted({ turn, output: action.output, at })
      : turnFailed({ turn, error: action.error, at })

const inferMachine = (
  render: RenderPlan,
  selection: InferenceSelection,
  giveUpAfter: number,
  deferAtMost: number,
  repairAtMost: number
) =>
  machine({
    id: "inference",
    initial: "idle",
    context: { turn: "" },
    view: turnView,
    states: {
      idle: {
        on: {
          MessageReceived: {
            target: "thinking",
            assign: (_, event) => ({ turn: String(event.id ?? "") })
          }
        }
      },
      thinking: {
        act: (log, context) =>
          Effect.gen(function* () {
            const turn = context.turn
            const view = turnView(log)
            const at = yield* Clock.currentTimeMillis
            const died = diedAttempts(view)
            const key = openCallId(view) ?? `${turn}/infer/${completedCalls(view)}`
            if (died >= giveUpAfter) {
              return [
                ...closeOrphan(view, turn, at),
                turnFailed({
                  turn,
                  error: `the model attempt died ${giveUpAfter} times in a row`,
                  at
                })
              ]
            }
            const rejections = view.filter((event) => event.type === "AnswerRejected").length
            if (rejections > repairAtMost) {
              return [
                turnFailed({
                  turn,
                  error: `the answer did not satisfy the declared schema after ${repairAtMost} corrections`,
                  at
                })
              ]
            }
            const deferrals = deferralsOf(view, key)
            if (deferrals >= deferAtMost) {
              return [
                ...closeOrphan(view, turn, at),
                turnFailed({
                  turn,
                  error: `the model was deferred ${deferAtMost} times`,
                  at
                })
              ]
            }
            // An orphaned mark is a crash mid-call. Close the reservation so cost does not vanish,
            // then journal the wait so a restart sleeps instead of immediately issuing another
            // request against a queue that has not moved.
            if (died > 0) {
              return [
                ...closeOrphan(view, turn, at),
                modelDeferred({
                  turn,
                  callId: key,
                  attempt: died,
                  notBefore: at + deferDelayMs(died),
                  reason: "the model attempt died",
                  at
                })
              ]
            }
            const store = yield* EventLog
            const override = yield* Effect.serviceOption(Infer)
            const provider = Option.getOrElse(override, () => selectedInference(selection, log))
            const request = modelRequest({ render }, log)
            const reserved = reservedUsage(request, provider.state(log).pricing)
            yield* store.append([
              modelCalled({
                turn,
                callId: key,
                reserved,
                ...(request.options === undefined ? {} : { options: request.options }),
                at
              })
            ])
            const action = yield* provider.react(request, key)
            const after = yield* Clock.currentTimeMillis
            const usage = settledUsage(action.usage, reserved, provider.state(log).pricing)
            if (action.kind === "defer") {
              const attempt = deferrals + 1
              return [
                modelSettled({
                  turn,
                  callId: key,
                  usage,
                  reason: action.error,
                  at: after
                }),
                modelDeferred({
                  turn,
                  callId: key,
                  attempt,
                  notBefore: after + deferDelayMs(attempt, action.retryAfterMs),
                  reason: action.error,
                  at: after
                })
              ]
            }
            const continuation = action.kind === "fail" ? undefined : action.continuation
            return [
              modelReturned({
                turn,
                callId: key,
                usage,
                ...(continuation === undefined ? {} : { continuation }),
                at: after
              }),
              ...(action.kind === "call" && action.text !== undefined && action.text !== ""
                ? [textReturned({ turn, text: action.text, at: after })]
                : []),
              consequenceOf(action, turn, after)
            ]
          }),
        on: {
          ModelDeferred: "deferred",
          ToolCalled: "waiting",
          TurnCompleted: "idle",
          TurnFailed: "idle"
        }
      },
      deferred: { on: { AlarmFired: "thinking" } },
      waiting: { on: { ToolReturned: "thinking" } }
    }
  })

const replyMachine = machine({
  id: "reply",
  view: replyView,
  initial: "idle",
  states: {
    idle: { on: { MessageReceived: "open" } },
    open: { on: { TurnCompleted: "replying", TurnFailed: "replying" } },
    replying: {
      act: (log) =>
        Effect.gen(function* () {
          const view = replyView(log)
          const head = view[0]
          const terminal = view.find(
            (event) => event.type === "TurnCompleted" || event.type === "TurnFailed"
          )
          if (head === undefined || terminal === undefined) {
            return yield* Effect.die(
              new Error("replying with no finished turn: the fold and the machine disagree")
            )
          }
          const turn = String(head.id ?? "")
          const at = yield* Clock.currentTimeMillis
          if (head.replyTo === undefined) return [replyDelivered({ turn, at })]
          const to = String(head.replyTo)
          const failed = terminal.type === "TurnFailed"
          const session = yield* Self
          // The reply names its origin and carries this turn's inclusive usage, so the receiver
          // can attribute and cost the exchange without reading this session's log.
          yield* (yield* Router).deliver(
            to,
            messageReceived({
              id: `reply:${turn}`,
              text: failed ? `error: ${String(terminal.error ?? "")}` : String(terminal.output ?? ""),
              outcome: failed ? "failed" : "completed",
              origin: { session, turn },
              usage: treeUsageIn(log, turn),
              at
            })
          )
          return [replyDelivered({ turn, to, at })]
        }),
      on: { ReplyDelivered: "idle" }
    }
  }
})

// The type says one of the two is there. Generated code meets no type, so the construction says it
// too, and it names both ways out rather than only the one this function happens to take.
const selectionOf = (options: InferenceOptions): InferenceSelection => {
  if (options.provider !== undefined) return options.provider
  if (options.contextWindow === undefined) {
    throw new Error(
      "inference needs a provider or a contextWindow: a module has to say what the model " +
        "accepts. Pass contextWindow to take the default gateway with it, or build a provider " +
        "with `yield* vercelGatewayInference()` to read the window from the model."
    )
  }
  return vercelGatewayInference({ contextWindow: options.contextWindow })
}

export const inference = (options: InferenceOptions) => {
  const selection = selectionOf(options)
  const system = options.system ?? BASE_SYSTEM
  const giveUpAfter = options.giveUpAfter ?? 3
  const deferAtMost = options.deferAtMost ?? 8
  const repairAtMost = options.repairAtMost ?? 2
  // Truncation is what the caller asked for and nothing more. A default bound here would cut a long
  // message down on the way to the model while the log kept the whole thing, so the record and the
  // request would disagree and only the request is what the model answered.
  const truncation = {
    ...(options.messageTruncateAt === undefined
      ? {}
      : { messageTruncateAt: options.messageTruncateAt }),
    ...(options.resultTruncateAt === undefined
      ? {}
      : { resultTruncateAt: options.resultTruncateAt })
  }
  const initial = selectedInference(selection, [])
  const state: Projection<InferenceState> = (log) => {
    const provider = selectedInference(selection, log)
    return provider.state(log)
  }
  return defineModule({
    id: "inference",
    version: "5",
    identity: {
      provider: initial.id,
      state: initial.state([]),
      system,
      giveUpAfter,
      deferAtMost,
      repairAtMost,
      ...truncation
    },
    services: Context.make(InferenceStateProjection, state),
    setup: () => ({
      // The model loop emits the tool call and then waits on its result, so both belong here even
      // though the native-tools module is what dispatches one.
      events: [
        "MessageReceived",
        "ModelCalled",
        "ModelDeferred",
        "AlarmFired",
        "ModelSettled",
        "ModelReturned",
        "TextReturned",
        "ToolCalled",
        "ToolReturned",
        "TurnCompleted",
        "TurnFailed",
        "ReplyDelivered"
      ],
      instructions: [{ id: "inference.system", text: system }],
      render: truncation,
      // The requirements are declared rather than cast away. The model loop reaches the log and the
      // reply machine reaches the router and this session's name, so the module says so and the
      // agent's own requirement carries it to the runtime.
      machines: (render): ReadonlyArray<Machine<EventLog | Router | Self, never>> => [
        erase(inferMachine(render, selection, giveUpAfter, deferAtMost, repairAtMost)),
        erase(replyMachine)
      ]
    })
  })
}
