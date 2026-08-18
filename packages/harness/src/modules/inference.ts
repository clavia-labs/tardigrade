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
  type InferenceState,
  type RequestOptions
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
import { pendingDeferral, replyView, treeUsageIn, turnView } from "../turns"
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
  // How many times one model call may wait before the turn gives up. It bounds a queue that never
  // drains and a process that dies mid-call alike, because both journal the same wait.
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

// A mark with nothing after it: the process died between the request and its outcome. Anything that
// closes the mark, a result or a settle, ends the search, so an attempt that was already accounted
// for is not counted again.
const openCall = (view: ReadonlyArray<Event>): Event | undefined => {
  for (let index = view.length - 1; index >= 0; index--) {
    const event = view[index]
    if (event === undefined) continue
    if (event.type === "ModelReturned" || event.type === "ModelSettled") return undefined
    if (event.type === "ModelCalled") return event
  }
  return undefined
}

// The call a retry continues: a mark that no result has answered. A deferral settles its own attempt
// for accounting, so the mark is no longer open, but the call it names is still unanswered and the
// next attempt is the same call. Reusing its key is what tells the gateway so.
//
// A mark a result did answer ends the search, because the next request is a new call rather than
// another attempt at that one.
const unanswered = (view: ReadonlyArray<Event>): Event | undefined => {
  for (let index = view.length - 1; index >= 0; index--) {
    const event = view[index]
    if (event?.type === "ModelReturned") return undefined
    if (event?.type === "ModelCalled") return event
  }
  return undefined
}

// The ordinal a new call takes. Marks rather than results, so a key minted after several attempts
// can not collide with the one those attempts shared.
const marksIn = (view: ReadonlyArray<Event>) =>
  view.filter((event) => event.type === "ModelCalled").length

// Close a reservation whose attempt never produced a result, so spend that was probably billed stays
// on the record. Only an open mark is closed: a settled attempt has already been accounted for, and
// settling it twice would report a turn spending what it never asked for.
const closeOpen = (view: ReadonlyArray<Event>, turn: string, at: number): ReadonlyArray<Event> => {
  const called = openCall(view)
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

const deferralsOf = (view: ReadonlyArray<Event>, callId: string) =>
  view.filter((event) => event.type === "ModelDeferred" && String(event.callId ?? "") === callId)
    .length

// Whether the settings a retry would send still match the ones the open call was made with. They can
// differ, because the options are a projection and a policy may read the deferrals it caused. A
// request the gateway would treat as the same call has to be the same request, so a changed setting
// mints a new call rather than reusing a key that now describes something else.
const sameOptions = (called: Event | undefined, options: RequestOptions | undefined) =>
  JSON.stringify(called?.options ?? null) === JSON.stringify(options ?? null)

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
            const store = yield* EventLog
            const override = yield* Effect.serviceOption(Infer)
            const provider = Option.getOrElse(override, () => selectedInference(selection, log))
            const state = provider.state(log)
            const request = modelRequest({ render }, log)
            const previous = unanswered(view)
            const key =
              previous !== undefined && sameOptions(previous, request.options)
                ? String(previous.callId ?? "")
                : `${turn}/infer/${marksIn(view)}`
            const deferrals = deferralsOf(view, key)
            if (deferrals >= deferAtMost) {
              return [
                ...closeOpen(view, turn, at),
                turnFailed({
                  turn,
                  error: `the model was deferred ${deferAtMost} times`,
                  at
                })
              ]
            }
            // An open mark is a crash between the request and its outcome. Close the reservation so
            // the spend does not vanish, then journal the wait so a restart sleeps instead of
            // immediately issuing another request against a queue that has not moved.
            if (openCall(view) !== undefined) {
              const attempt = deferrals + 1
              return [
                ...closeOpen(view, turn, at),
                modelDeferred({
                  turn,
                  callId: key,
                  attempt,
                  notBefore: at + deferDelayMs(attempt),
                  reason: "the model attempt died",
                  at
                })
              ]
            }
            const reserved = reservedUsage(request, state.pricing, state.maxOutputTokens)
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
            const usage = settledUsage(action.usage, reserved, state.pricing)
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
      // Only the wake this wait is owed reopens it. A wake is delivered by a runtime and redelivery
      // is the contract an act is written against, so a stale or repeated one would otherwise retry
      // against a queue before its due time, which is the failure the wait exists to prevent.
      deferred: {
        on: {
          AlarmFired: {
            target: "thinking",
            // The guard reads the log up to and including the wake, so the wake is its last event
            // and the wait it claims to answer is whatever the log held before it.
            when: (log) => {
              const wake = log[log.length - 1]
              const pending = pendingDeferral(log.slice(0, -1))
              return (
                pending !== undefined &&
                pending.callId === String(wake?.callId ?? "") &&
                pending.attempt === Number(wake?.attempt ?? -1)
              )
            }
          }
        }
      },
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
    version: "6",
    identity: {
      provider: initial.id,
      state: initial.state([]),
      system,
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
        erase(inferMachine(render, selection, deferAtMost, repairAtMost)),
        erase(replyMachine)
      ]
    })
  })
}
