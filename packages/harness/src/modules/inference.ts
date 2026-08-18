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
  answerTruncated,
  compactionFired,
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
import { windowError } from "../providers/model"

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
  // How many times one answer may be cut at the model's output ceiling before the turn gives up. It
  // counts the answer being written now rather than the turn, so a turn that writes several long
  // documents gets the bound for each of them.
  readonly continueAtMost?: number
  // Whether the loop may compact in the middle of a turn, when the next request plus its answer
  // would not fit the window. It is off by default because it names a dependency this module cannot
  // satisfy alone: something has to answer `CompactionFired` with a checkpoint. Turning it on
  // without a compaction module is a construction error rather than a turn that never returns.
  // `defaultPack` turns it on, because that pack ships compaction.
  readonly compactMidTurn?: boolean
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

// The most recent mark, unless one of `closedBy` has already come after it. Both questions this
// module asks about a mark are that search over a different set, so they are the same fold read two
// ways rather than two folds.
const markUnless = (
  view: ReadonlyArray<Event>,
  closedBy: ReadonlySet<string>
): Event | undefined => {
  for (let index = view.length - 1; index >= 0; index--) {
    const event = view[index]
    if (event === undefined) continue
    if (closedBy.has(event.type)) return undefined
    if (event.type === "ModelCalled") return event
  }
  return undefined
}

// A mark with nothing after it: the process died between the request and its outcome. A result or a
// settle closes it, so an attempt already accounted for is not counted again.
const openCall = (view: ReadonlyArray<Event>) =>
  markUnless(view, new Set(["ModelReturned", "ModelSettled"]))

// The call a retry continues: a mark no result has answered. A deferral settles its own attempt for
// accounting, so the mark is no longer open, but the call it names is still unanswered and the next
// attempt is the same call. Reusing its key is what tells the gateway so.
const unanswered = (view: ReadonlyArray<Event>) => markUnless(view, new Set(["ModelReturned"]))

// The ordinal a new call takes. Marks rather than results, so a key minted after several attempts
// can not collide with the one those attempts shared.
const marksIn = (view: ReadonlyArray<Event>) =>
  view.filter((event) => event.type === "ModelCalled").length

// Close a reservation whose attempt never produced a result, so spend that was probably billed stays
// on the record. The caller passes the mark it already found, because settling one that a result or
// an earlier settle had closed would report a turn spending what it never asked for.
const closed = (open: Event | undefined, turn: string, at: number): ReadonlyArray<Event> =>
  open === undefined
    ? []
    : [
        modelSettled({
          turn,
          callId: String(open.callId ?? ""),
          usage: usageOf(open.reserved),
          reason: "the model attempt died",
          at
        })
      ]

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

// Compactions fired since the last model attempt in this turn. One is a request that would not fit
// being given a smaller log to fit in. A second, with no attempt in between, means the checkpoint
// the first produced did not buy enough room, and firing again would ask the same question of the
// same log forever. Anchoring on `ModelCalled` rather than on the newest event keeps the count
// honest when another module appends between the checkpoint and this decide.
const firedSinceCall = (view: ReadonlyArray<Event>): number => {
  let fired = 0
  for (let index = view.length - 1; index >= 0; index--) {
    const event = view[index]
    if (event === undefined) continue
    if (event.type === "ModelCalled") break
    if (event.type === "CompactionFired") fired += 1
  }
  return fired
}

// The fragments of the answer being written now. A tool call ends an answer, so the count and the
// stitch both start again after one: a turn that writes three long documents gets its continuations
// for each of them rather than spending one turn's worth on the first.
const fragmentsOf = (view: ReadonlyArray<Event>): ReadonlyArray<string> => {
  let parts: Array<string> = []
  for (const event of view) {
    if (event.type === "AnswerTruncated") parts.push(String(event.text ?? ""))
    if (event.type === "ToolCalled" || event.type === "ToolReturned") parts = []
  }
  return parts
}

const consequenceOf = (
  action: Extract<Action, { kind: "call" | "complete" | "fail" }>,
  view: ReadonlyArray<Event>,
  turn: string,
  at: number
): Event =>
  action.kind === "call"
    ? toolCalled({
        turn,
        callId: action.callId,
        name: action.name,
        arguments: action.arguments,
        at
      })
    : action.kind === "complete"
      ? turnCompleted({
          turn,
          // One answer the provider split across attempts, put back together. The fragments were
          // paid for and the caller asked for an answer rather than its last instalment, and a
          // sub-agent's parent reads this field alone.
          output: `${fragmentsOf(view).join("")}${action.output}`,
          at
        })
      : turnFailed({ turn, error: action.error, at })

// A truncation resumes in the same slot that made it, so the loop needs two names for one act:
// emitting `AnswerTruncated` while resting in `thinking` would leave the fold in `thinking`, and
// the runtime reads a state that emitted without moving as a wedge and dies. Continuing is the
// same act under the other name, and a second truncation moves back.
const inferOn = (truncated: "thinking" | "continuing") => ({
  ModelDeferred: "deferred" as const,
  ToolCalled: "waiting" as const,
  TurnCompleted: "idle" as const,
  TurnFailed: "idle" as const,
  AnswerTruncated: truncated
})

const inferMachine = (
  render: RenderPlan,
  selection: InferenceSelection,
  deferAtMost: number,
  repairAtMost: number,
  continueAtMost: number,
  compactMidTurn: boolean
) => {
  const think = (log: ReadonlyArray<Event>, context: { readonly turn: string }) =>
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
            const truncations = fragmentsOf(view).length
            if (truncations > continueAtMost) {
              return [
                turnFailed({
                  turn,
                  error: `the answer was truncated ${continueAtMost} times and still did not finish`,
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
            const open = openCall(view)
            const deferrals = deferralsOf(view, key)
            const attempt = deferrals + 1
            if (deferrals >= deferAtMost) {
              return [
                ...closed(open, turn, at),
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
            if (open !== undefined) {
              return [
                ...closed(open, turn, at),
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
            // The model has to read the conversation and still have room to answer it, and the
            // reservation is already that sum: the prompt exactly, the answer at its ceiling. This
            // is the same total the provider refuses on, checked one step earlier, where a
            // checkpoint can still make it fit. It is the hard limit rather than a ratio, because
            // how full a log may get before compacting is worth doing is the compaction module's
            // policy, and a second copy of that ratio here could disagree with the author's.
            //
            // Without a compaction module there is nothing this could wait for, so the request goes
            // and the provider refuses it by name.
            if (
              compactMidTurn &&
              reserved.promptTokens + reserved.completionTokens > state.contextWindow
            ) {
              if (firedSinceCall(view) > 0) {
                return [
                  turnFailed({
                    turn,
                    error: windowError(
                      reserved.promptTokens,
                      state.provider,
                      state.model,
                      state.contextWindow,
                      reserved.completionTokens
                    ),
                    at
                  })
                ]
              }
              return [compactionFired({ turn, at })]
            }
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
            // The ceiling stopped the answer, not the window: the request was measured with its
            // output reserved before it was sent, so there was room for an answer this size. The
            // fragment and its cost are recorded, and the next pass renders it as what the model
            // has said so far.
            if (action.kind === "truncated") {
              const returned = modelReturned({
                turn,
                callId: key,
                usage,
                ...(action.continuation === undefined ? {} : { continuation: action.continuation }),
                at: after
              })
              const recorded = answerTruncated({
                turn,
                callId: key,
                text: action.text,
                tokens: usage.completionTokens,
                ...(action.call === undefined
                  ? {}
                  : { tool: action.call.name, arguments: action.call.arguments }),
                at: after
              })
              if (truncations + 1 > continueAtMost) {
                return [
                  returned,
                  recorded,
                  turnFailed({
                    turn,
                    error: `the answer was truncated ${continueAtMost} times and still did not finish`,
                    at: after
                  })
                ]
              }
              return [returned, recorded]
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
              consequenceOf(action, view, turn, after)
            ]
          })
  const idle = {
    on: {
      MessageReceived: {
        target: "thinking",
        assign: (_: { readonly turn: string }, event: Event) => ({ turn: String(event.id ?? "") })
      }
    }
  } as const
  // Only the wake this wait is owed reopens it. A wake is delivered by a runtime and redelivery
  // is the contract an act is written against, so a stale or repeated one would otherwise retry
  // against a queue before its due time, which is the failure the wait exists to prevent.
  const deferred = {
    on: {
      AlarmFired: {
        target: "thinking",
        // The guard reads the log up to and including the wake, so the wake is its last event
        // and the wait it claims to answer is whatever the log held before it.
        when: (log: ReadonlyArray<Event>) => {
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
  } as const
  const waiting = { on: { ToolReturned: "thinking" } } as const
  const common = { id: "inference", initial: "idle", context: { turn: "" }, view: turnView } as const
  // Two shapes rather than one with an optional state. A machine's states are the alphabet its
  // targets are checked against, so a state that is only sometimes there would weaken that check
  // for the states that are always there.
  //
  // Resting in `compacting` until the checkpoint exists is the whole point of firing: the request
  // this loop would have sent does not fit, and re-rendering before the summary lands would send it
  // anyway. `CompactionCompleted` is deliberately absent from this module's alphabet, so an agent
  // that asks for mid-turn compaction without a module that writes checkpoints fails to compile
  // rather than resting here for good.
  if (compactMidTurn) {
    return machine({
      ...common,
      states: {
        idle,
        thinking: { act: think, on: { ...inferOn("continuing"), CompactionFired: "compacting" } },
        continuing: { act: think, on: { ...inferOn("thinking"), CompactionFired: "compacting" } },
        compacting: { on: { CompactionCompleted: "thinking" } },
        deferred,
        waiting
      }
    })
  }
  return machine({
    ...common,
    states: {
      idle,
      thinking: { act: think, on: inferOn("continuing") },
      continuing: { act: think, on: inferOn("thinking") },
      deferred,
      waiting
    }
  })
}

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
  const continueAtMost = options.continueAtMost ?? 8
  const compactMidTurn = options.compactMidTurn ?? false
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
    version: "7",
    identity: {
      provider: initial.id,
      state: initial.state([]),
      system,
      deferAtMost,
      repairAtMost,
      continueAtMost,
      compactMidTurn,
      ...truncation
    },
    services: Context.make(InferenceStateProjection, state),
    setup: () => ({
      // The model loop emits the tool call and then waits on its result, so both belong here even
      // though the native-tools module is what dispatches one. `CompactionFired` joins them when
      // the loop may fire mid-turn, because the loop is what emits it. `CompactionCompleted` does
      // not: this module reads that event but never writes one, and declaring an event no module
      // emits is what would let a missing compaction module rest here forever.
      events: [
        "MessageReceived",
        "ModelCalled",
        "ModelDeferred",
        "AlarmFired",
        "ModelSettled",
        "ModelReturned",
        "TextReturned",
        "AnswerTruncated",
        "ToolCalled",
        "ToolReturned",
        "TurnCompleted",
        "TurnFailed",
        "ReplyDelivered",
        ...(compactMidTurn ? ["CompactionFired"] : [])
      ],
      instructions: [{ id: "inference.system", text: system }],
      render: truncation,
      // The requirements are declared rather than cast away. The model loop reaches the log and the
      // reply machine reaches the router and this session's name, so the module says so and the
      // agent's own requirement carries it to the runtime.
      machines: (render): ReadonlyArray<Machine<EventLog | Router | Self, never>> => [
        erase(
          inferMachine(
            render,
            selection,
            deferAtMost,
            repairAtMost,
            continueAtMost,
            compactMidTurn
          )
        ),
        erase(replyMachine)
      ]
    })
  })
}
