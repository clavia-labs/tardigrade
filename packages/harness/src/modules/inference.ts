import { Clock, Context, Effect, Option } from "effect"
import { EventLog, Router, Self, erase, machine, type Event, type Machine } from "@flamecast/core"
import {
  Infer,
  selectedInference,
  usageOf,
  type Action,
  type InferenceSelection,
  type InferenceState
} from "../infer"
import {
  messageReceived,
  modelCalled,
  modelReturned,
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

export interface InferenceOptions {
  readonly provider?: InferenceSelection
  readonly system?: string
  readonly giveUpAfter?: number
  readonly repairAtMost?: number
  readonly messageTruncateAt?: number
  readonly resultTruncateAt?: number
}

const diedAttempts = (view: ReadonlyArray<Event>): number => {
  let died = 0
  for (let index = view.length - 1; index >= 0; index--) {
    if (view[index]?.type !== "ModelCalled") break
    died += 1
  }
  return died
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
            if (died >= giveUpAfter) {
              return [
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
            const marks = view.filter((event) => event.type === "ModelCalled").length
            const key = `${turn}/infer/${marks - died}`
            const store = yield* EventLog
            yield* store.append([modelCalled({ turn, callId: key, at })])
            const override = yield* Effect.serviceOption(Infer)
            const provider = Option.getOrElse(override, () => selectedInference(selection, log))
            const action = yield* provider.react(modelRequest({ render }, log), key)
            const after = yield* Clock.currentTimeMillis
            return [
              modelReturned({ turn, callId: key, usage: usageOf(action.usage), at: after }),
              ...(action.kind === "call" && action.text !== undefined && action.text !== ""
                ? [textReturned({ turn, text: action.text, at: after })]
                : []),
              consequenceOf(action, turn, after)
            ]
          }),
        on: { ToolCalled: "waiting", TurnCompleted: "idle", TurnFailed: "idle" }
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

export const inference = (options: InferenceOptions = {}) => {
  const selection = options.provider ?? vercelGatewayInference()
  const system = options.system ?? BASE_SYSTEM
  const giveUpAfter = options.giveUpAfter ?? 3
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
    version: "2",
    identity: {
      provider: initial.id,
      state: initial.state([]),
      system,
      giveUpAfter,
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
        "ModelReturned",
        "TextReturned",
        "ToolCalled",
        "ToolReturned",
        "TurnCompleted",
        "TurnFailed",
        "ReplyDelivered"
      ],
      projections: { [InferenceStateProjection.key]: state },
      instructions: [{ id: "inference.system", text: system }],
      render: truncation,
      // The requirements are declared rather than cast away. The model loop reaches the log and the
      // reply machine reaches the router and this session's name, so the module says so and the
      // agent's own requirement carries it to the runtime.
      machines: (render): ReadonlyArray<Machine<EventLog | Router | Self, never>> => [
        erase(inferMachine(render, selection, giveUpAfter, repairAtMost)),
        erase(replyMachine)
      ]
    })
  })
}
