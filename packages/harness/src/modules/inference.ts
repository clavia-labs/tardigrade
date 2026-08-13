import { Clock, Effect, Option } from "effect"
import { EventLog, Router, erase, machine, type Envelope, type Machine } from "@flamecast/core"
import {
  Infer,
  selectedInference,
  usageOf,
  type Action,
  type InferenceSelection,
  type InferenceState
} from "../infer"
import { defineModule } from "../module"
import type { RenderPlan } from "../program"
import { modelRequest } from "../render"
import { announce, signal } from "../signal"
import { replyView, turnView } from "../turns"
import { vercelGatewayInference } from "../providers/vercel-gateway"

const BASE_SYSTEM =
  "You are an agent. Read the conversation, use the tools you are offered when they help, and " +
  "answer the person who wrote to you. When the work is done, reply in plain text: that reply is " +
  "your final answer and it ends the turn."

export const inferenceState = signal<"inference.state", InferenceState>("inference.state")

export interface InferenceOptions {
  readonly provider?: InferenceSelection
  readonly system?: string
  readonly giveUpAfter?: number
  readonly repairAtMost?: number
  readonly messageTruncateAt?: number
  readonly resultTruncateAt?: number
}

const diedAttempts = (view: ReadonlyArray<Envelope>): number => {
  let died = 0
  for (let index = view.length - 1; index >= 0; index--) {
    if (view[index]?.type !== "ModelCalled") break
    died += 1
  }
  return died
}

const consequenceOf = (action: Action, turn: string, at: number): Envelope =>
  action.kind === "call"
    ? {
        type: "ToolCalled",
        turn,
        callId: action.callId,
        name: action.name,
        arguments: action.arguments,
        at
      }
    : action.kind === "complete"
      ? { type: "TurnCompleted", turn, output: action.output, at }
      : { type: "TurnFailed", turn, error: action.error, at }

const inferMachine = (
  render: RenderPlan,
  selection: InferenceSelection,
  giveUpAfter: number,
  repairAtMost: number
) =>
  machine<EventLog, { readonly turn: string }>({
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
                {
                  type: "TurnFailed",
                  turn,
                  error: `the model attempt died ${giveUpAfter} times in a row`,
                  at
                }
              ]
            }
            const rejections = view.filter((event) => event.type === "AnswerRejected").length
            if (rejections > repairAtMost) {
              return [
                {
                  type: "TurnFailed",
                  turn,
                  error: `the answer did not satisfy the declared schema after ${repairAtMost} corrections`,
                  at
                }
              ]
            }
            const marks = view.filter((event) => event.type === "ModelCalled").length
            const key = `${turn}/infer/${marks - died}`
            const store = yield* EventLog
            yield* store.append([{ type: "ModelCalled", turn, callId: key, at }])
            const override = yield* Effect.serviceOption(Infer)
            const provider = Option.getOrElse(override, () => selectedInference(selection, log))
            const action = yield* provider.react(modelRequest({ render }, log), key)
            const after = yield* Clock.currentTimeMillis
            return [
              { type: "ModelReturned", turn, callId: key, usage: usageOf(action.usage), at: after },
              ...(action.kind === "call" && action.text !== undefined && action.text !== ""
                ? [{ type: "TextReturned", turn, text: action.text, at: after }]
                : []),
              consequenceOf(action, turn, after)
            ]
          }),
        on: { ToolCalled: "waiting", TurnCompleted: "idle", TurnFailed: "idle" }
      },
      waiting: { on: { ToolReturned: "thinking" } }
    }
  })

const replyMachine = machine<Router>({
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
          if (head.replyTo === undefined) return [{ type: "ReplyDelivered", turn, at }]
          const to = String(head.replyTo)
          const failed = terminal.type === "TurnFailed"
          yield* (yield* Router).deliver(to, {
            type: "MessageReceived",
            id: `reply:${turn}`,
            text: failed ? `error: ${String(terminal.error ?? "")}` : String(terminal.output ?? ""),
            outcome: failed ? "failed" : "completed",
            at
          })
          return [{ type: "ReplyDelivered", turn, to, at }]
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
  const messageTruncateAt = options.messageTruncateAt ?? 12_000
  const resultTruncateAt = options.resultTruncateAt ?? 6_000
  const initial = selectedInference(selection, [])
  return defineModule({
    id: "inference",
    version: "2",
    fingerprint: {
      provider: initial.id,
      state: initial.state([]),
      system,
      giveUpAfter,
      repairAtMost,
      messageTruncateAt,
      resultTruncateAt
    },
    provides: [
      announce(inferenceState, (log) => {
        const provider = selectedInference(selection, log)
        return provider.state(log)
      })
    ] as const,
    setup: () => ({
      events: [
        "MessageReceived",
        "ModelCalled",
        "ModelReturned",
        "TextReturned",
        "TurnCompleted",
        "TurnFailed",
        "ReplyDelivered"
      ],
      instructions: [{ id: "inference.system", text: system }],
      render: { messageTruncateAt, resultTruncateAt },
      machines: (render) =>
        [
          erase(inferMachine(render, selection, giveUpAfter, repairAtMost)),
          replyMachine
        ] as unknown as ReadonlyArray<Machine<never>>
    })
  })
}
