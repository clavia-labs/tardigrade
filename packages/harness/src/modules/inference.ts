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
import { replyView, treeUsageIn, turnView } from "../turns"
import { vercelGatewayInference } from "../providers/vercel-gateway"
import { windowError } from "../providers/http"

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
  giveUpAfter: number,
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
      const state = provider.state(log)
      const reserved = reservedUsage(request, state.pricing)
      const output = request.options?.maxOutputTokens ?? state.maxOutputTokens ?? 0
      // The model has to read the conversation and still have room to answer it, so the request is
      // measured against the window with its output ceiling reserved. This is the same sum the
      // provider refuses on, checked one step earlier, where a checkpoint can still make it fit. It
      // is the hard limit rather than a ratio: how full a log may get before it is worth compacting
      // is the compaction module's policy, and a second copy of that ratio here would be a policy
      // this loop invented that could disagree with the one the author set.
      //
      // Without a compaction module there is nothing this could wait for, so the request goes and
      // the provider refuses it by name.
      if (compactMidTurn && reserved.promptTokens + output > state.contextWindow) {
        if (firedSinceCall(view) > 0) {
          return [
            turnFailed({
              turn,
              error: windowError(
                reserved.promptTokens,
                state.provider,
                state.model,
                state.contextWindow,
                output
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
      // The ceiling stopped the answer, not the window: the request was measured with its output
      // reserved before it was sent, so there was room for an answer this size. The fragment and
      // its cost are recorded, and the next pass renders it as what the model has said so far.
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
  const deferred = { on: { AlarmFired: "thinking" } } as const
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
  const giveUpAfter = options.giveUpAfter ?? 3
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
    version: "6",
    identity: {
      provider: initial.id,
      state: initial.state([]),
      system,
      giveUpAfter,
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
            giveUpAfter,
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
